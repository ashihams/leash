import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { z } from "zod";
import { ApiError } from "../lib/api-error.ts";
import {
  NONCE_TTL_SECONDS,
  REVIEW_TIMEOUT_SECONDS,
  WALLET_PURPOSES,
  WALLET_TOKEN_TTL_SECONDS,
  challengeMessage,
  reviewMessage,
  type WalletPurpose,
} from "../lib/messages.ts";
import { expectedGateOutcome, vendorStats } from "../lib/outcomes.ts";
import type { HistoryRepository, Profile } from "../lib/repository.ts";
import { readWalletToken, signWalletToken } from "../lib/wallet-token.ts";
import { requireProfile, requireRole } from "../middleware/dashboard.ts";

const textEncoder = new TextEncoder();

const pubkey = z
  .string()
  .refine((value) => {
    try {
      return bs58.decode(value).length === 32;
    } catch {
      return false;
    }
  }, "pubkey");

const paymentId = z.string().regex(/^[0-9a-f]{64}$/);
const digits = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform((value) => String(value));

const challengeBody = z.object({
  wallet: pubkey,
  purpose: z.enum(WALLET_PURPOSES),
});

const verifyBody = z.object({
  wallet: pubkey,
  nonce: z.string().min(16).max(128),
  signature: z.string().min(32).max(128),
});

const linkBody = z.object({
  walletToken: z.string().min(20).max(2048),
  kind: z.enum(["owner", "reviewer"]),
});

const checkBody = z.object({
  paymentId,
  checkId: z.string().min(1).max(64),
  status: z.enum(["pass", "flag", "fail"]),
  reasonCode: z.string().max(64).default(""),
  evidenceHash: z.string().max(128).default(""),
});

const clearanceBody = z.object({
  paymentId,
  decision: z.enum(["allow", "review", "deny"]),
  checksRun: digits,
  checksFailed: digits,
  policyVersion: digits,
  listVersion: digits,
  expiresAt: z.string().min(4),
  signature: z.string().min(32).max(256),
  buyer: pubkey,
  vendor: pubkey,
  amountUsdc: digits,
  status: z.enum([
    "funded",
    "delivered",
    "verified",
    "released",
    "refunded",
    "disputed",
  ]),
});

const reviewCreateBody = z.object({
  paymentId,
  flagged: z.record(z.string(), z.unknown()).default({}),
});

const decisionBody = z.object({
  status: z.enum(["approved", "denied"]),
  wallet: pubkey,
  nonce: z.string().min(16).max(128),
  signature: z.string().min(32).max(128),
});

export type HistoryDeps = {
  db: HistoryRepository;
  getDashboardUser: (
    token: string,
  ) => Promise<{ id: string; email: string } | null>;
  internalSecret: string;
  tokenSecretKey: Uint8Array;
  tokenPublicKey: Uint8Array;
  now?: () => number;
  reviewTimeoutSeconds?: number;
};

export function registerHistoryRoutes(
  app: FastifyInstance,
  deps: HistoryDeps,
): void {
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);
  const reviewTimeout = deps.reviewTimeoutSeconds ?? REVIEW_TIMEOUT_SECONDS;

  const guard =
    (
      handler: (
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        if (error instanceof ApiError) {
          return reply.code(error.statusCode).send({ error: error.code });
        }
        return reply.code(503).send({ error: "CHECK_UNAVAILABLE" });
      }
    };

  async function audit(entry: {
    actorType: "user" | "wallet" | "system";
    actorId: string;
    action: string;
    paymentId?: string | null;
    details?: Record<string, unknown>;
  }) {
    await deps.db.insertAudit({
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      paymentId: entry.paymentId ?? null,
      details: entry.details ?? {},
      createdAt: new Date(now() * 1000).toISOString(),
    });
  }

  async function profile(request: FastifyRequest): Promise<Profile> {
    return requireProfile(
      request,
      deps.getDashboardUser,
      (userId) => deps.db.getProfile(userId),
    );
  }

  function parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) throw new ApiError(400, "VALIDATION");
    return result.data;
  }

  function requireInternal(request: FastifyRequest) {
    const header = request.headers["x-internal-secret"];
    const got = Array.isArray(header) ? header[0] : header;
    if (!got || !secretMatches(deps.internalSecret, got)) {
      throw new ApiError(401, "UNAUTHORIZED");
    }
  }

  app.post(
    "/auth/challenge",
    guard(async (request) => {
      const body = parse(challengeBody, request.body);
      const issuedAt = now();
      const expiresAt = issuedAt + NONCE_TTL_SECONDS;
      const nonce = randomBytes(32).toString("hex");
      const message = challengeMessage({
        wallet: body.wallet,
        purpose: body.purpose,
        nonce,
        issuedAt,
        expiresAt,
      });
      await deps.db.insertNonce({
        nonce,
        wallet: body.wallet,
        purpose: body.purpose,
        issuedAt,
        expiresAt,
        used: false,
      });
      await audit({
        actorType: "wallet",
        actorId: body.wallet,
        action: "auth.challenge",
        details: { purpose: body.purpose, result: "ok" },
      });
      return { nonce, message, issuedAt, expiresAt };
    }),
  );

  app.post(
    "/auth/verify",
    guard(async (request) => {
      const body = parse(verifyBody, request.body);
      const row = await deps.db.findNonce(body.nonce);
      if (!row) {
        await audit({
          actorType: "wallet",
          actorId: body.wallet,
          action: "auth.verify",
          details: { result: "NONCE_INVALID" },
        });
        throw new ApiError(401, "NONCE_INVALID");
      }
      if (row.wallet !== body.wallet) {
        await audit({
          actorType: "wallet",
          actorId: body.wallet,
          action: "auth.verify",
          details: { result: "WALLET_MISMATCH" },
        });
        throw new ApiError(401, "WALLET_MISMATCH");
      }
      if (row.used) {
        await audit({
          actorType: "wallet",
          actorId: body.wallet,
          action: "auth.verify",
          details: { result: "NONCE_USED" },
        });
        throw new ApiError(401, "NONCE_USED");
      }
      if (row.expiresAt <= now()) {
        await audit({
          actorType: "wallet",
          actorId: body.wallet,
          action: "auth.verify",
          details: { result: "NONCE_EXPIRED" },
        });
        throw new ApiError(401, "NONCE_EXPIRED");
      }
      const purpose = row.purpose as WalletPurpose;
      if (!WALLET_PURPOSES.includes(purpose)) {
        throw new ApiError(401, "NONCE_INVALID");
      }
      const message = challengeMessage({
        wallet: row.wallet,
        purpose,
        nonce: row.nonce,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
      });
      if (!verifySignature(body.wallet, message, body.signature)) {
        await audit({
          actorType: "wallet",
          actorId: body.wallet,
          action: "auth.verify",
          details: { result: "SIGNATURE_INVALID" },
        });
        throw new ApiError(401, "SIGNATURE_INVALID");
      }
      const consumed = await deps.db.consumeNonce(row.nonce, row.wallet, now());
      if (!consumed) {
        await audit({
          actorType: "wallet",
          actorId: body.wallet,
          action: "auth.verify",
          details: { result: "NONCE_USED" },
        });
        throw new ApiError(401, "NONCE_USED");
      }
      const issuedAt = now();
      const token = signWalletToken(deps.tokenSecretKey, {
        wallet: row.wallet,
        purpose,
        iat: issuedAt,
        exp: issuedAt + WALLET_TOKEN_TTL_SECONDS,
      });
      await audit({
        actorType: "wallet",
        actorId: body.wallet,
        action: "auth.verify",
        details: { purpose, result: "ok" },
      });
      return { token, wallet: row.wallet, purpose, expiresAt: issuedAt + WALLET_TOKEN_TTL_SECONDS };
    }),
  );

  app.post(
    "/auth/link-wallet",
    guard(async (request) => {
      const user = await profile(request);
      const body = parse(linkBody, request.body);
      const claims = readWalletToken(
        deps.tokenPublicKey,
        body.walletToken,
        now(),
      );
      if (!claims || claims.purpose !== "link_wallet") {
        await audit({
          actorType: "user",
          actorId: user.id,
          action: "auth.link_wallet",
          details: { result: "UNAUTHORIZED" },
        });
        throw new ApiError(401, "UNAUTHORIZED");
      }
      if (body.kind === "reviewer" && user.role !== "reviewer") {
        await audit({
          actorType: "user",
          actorId: user.id,
          action: "auth.link_wallet",
          details: { result: "FORBIDDEN" },
        });
        throw new ApiError(403, "FORBIDDEN");
      }
      try {
        await deps.db.linkWallet({
          id: randomUUID(),
          userId: user.id,
          wallet: claims.wallet,
          kind: body.kind,
          verifiedAt: new Date(now() * 1000).toISOString(),
          createdAt: new Date(now() * 1000).toISOString(),
        });
      } catch (error) {
        if (error instanceof Error && error.message === "WALLET_TAKEN") {
          throw new ApiError(409, "WALLET_TAKEN");
        }
        throw error;
      }
      await audit({
        actorType: "user",
        actorId: user.id,
        action: "auth.link_wallet",
        details: { result: "ok", kind: body.kind },
      });
      return { ok: true, wallet: claims.wallet, kind: body.kind };
    }),
  );

  app.get(
    "/payments",
    guard(async (request) => {
      const user = await profile(request);
      requireRole(user, ["owner", "reviewer", "auditor"]);
      return { payments: await deps.db.listPayments() };
    }),
  );

  app.get(
    "/payments/:id/evidence",
    guard(async (request) => {
      const user = await profile(request);
      requireRole(user, ["owner", "reviewer", "auditor"]);
      const params = z.object({ id: paymentId }).safeParse(request.params);
      if (!params.success) throw new ApiError(400, "VALIDATION");
      const payment = await deps.db.getPayment(params.data.id);
      if (!payment) throw new ApiError(404, "NOT_FOUND");
      const [clearance, checks, review, entries] = await Promise.all([
        deps.db.getClearance(params.data.id),
        deps.db.listChecks(params.data.id),
        deps.db.getReview(params.data.id),
        deps.db.listAudit(params.data.id),
      ]);
      return { payment, clearance, checks, review, audit: entries };
    }),
  );

  app.post(
    "/internal/check-results",
    guard(async (request) => {
      requireInternal(request);
      const body = request.body as { results?: unknown } | unknown;
      const rows = Array.isArray((body as { results?: unknown }).results)
        ? (body as { results: unknown[] }).results
        : [body];
      const saved = [];
      for (const row of rows) {
        const check = parse(checkBody, row);
        const record = {
          id: randomUUID(),
          paymentId: check.paymentId,
          checkId: check.checkId,
          status: check.status,
          reasonCode: check.reasonCode,
          evidenceHash: check.evidenceHash,
          createdAt: new Date(now() * 1000).toISOString(),
        };
        await deps.db.insertCheck(record);
        saved.push(record.id);
      }
      return { ok: true, ids: saved };
    }),
  );

  app.post(
    "/internal/clearances",
    guard(async (request) => {
      requireInternal(request);
      const body = parse(clearanceBody, request.body);
      const createdAt = new Date(now() * 1000).toISOString();
      await deps.db.upsertPayment({
        paymentId: body.paymentId,
        buyer: body.buyer,
        vendor: body.vendor,
        amountUsdc: body.amountUsdc,
        status: body.status,
        createdAt,
      });
      await deps.db.upsertClearance({
        paymentId: body.paymentId,
        decision: body.decision,
        checksRun: body.checksRun,
        checksFailed: body.checksFailed,
        policyVersion: body.policyVersion,
        listVersion: body.listVersion,
        expiresAt: body.expiresAt,
        signature: body.signature,
        createdAt,
      });
      return { ok: true };
    }),
  );

  app.post(
    "/internal/reviews",
    guard(async (request) => {
      requireInternal(request);
      const body = parse(reviewCreateBody, request.body);
      await deps.db.insertReview({
        paymentId: body.paymentId,
        flagged: body.flagged,
        status: "pending",
        reviewerUserId: null,
        reviewerWallet: null,
        reviewerSignature: null,
        createdAt: new Date(now() * 1000).toISOString(),
        decidedAt: null,
      });
      return { ok: true };
    }),
  );

  app.get(
    "/reviews",
    guard(async (request) => {
      const user = await profile(request);
      requireRole(user, ["reviewer"]);
      await expireReviews(deps.db, now(), reviewTimeout);
      return { reviews: await deps.db.listReviews() };
    }),
  );

  app.post(
    "/reviews/:paymentId/decision",
    guard(async (request) => {
      const user = await profile(request);
      requireRole(user, ["reviewer"]);
      const params = z
        .object({ paymentId })
        .safeParse(request.params);
      if (!params.success) throw new ApiError(400, "VALIDATION");
      await expireReviews(deps.db, now(), reviewTimeout);
      const review = await deps.db.getReview(params.data.paymentId);
      if (!review) throw new ApiError(404, "NOT_FOUND");
      if (review.status === "timed_out") {
        throw new ApiError(409, "TIMED_OUT");
      }
      if (review.status !== "pending") {
        throw new ApiError(409, "ALREADY_DECIDED");
      }
      const body = parse(decisionBody, request.body);
      const linked = await deps.db.findLinked(user.id, body.wallet);
      if (!linked || linked.kind !== "reviewer" || !linked.verifiedAt) {
        await audit({
          actorType: "user",
          actorId: user.id,
          action: "review.decision",
          paymentId: params.data.paymentId,
          details: { result: "WALLET_NOT_LINKED" },
        });
        throw new ApiError(403, "WALLET_NOT_LINKED");
      }
      const nonce = await deps.db.findNonce(body.nonce);
      if (
        !nonce ||
        nonce.purpose !== "review" ||
        nonce.wallet !== body.wallet ||
        nonce.used ||
        nonce.expiresAt <= now()
      ) {
        await audit({
          actorType: "user",
          actorId: user.id,
          action: "review.decision",
          paymentId: params.data.paymentId,
          details: { result: "NONCE_INVALID" },
        });
        throw new ApiError(401, "NONCE_INVALID");
      }
      const message = reviewMessage({
        wallet: body.wallet,
        paymentId: params.data.paymentId,
        decision: body.status,
        nonce: body.nonce,
      });
      if (!verifySignature(body.wallet, message, body.signature)) {
        await audit({
          actorType: "user",
          actorId: user.id,
          action: "review.decision",
          paymentId: params.data.paymentId,
          details: { result: "SIGNATURE_INVALID" },
        });
        throw new ApiError(401, "SIGNATURE_INVALID");
      }
      const consumed = await deps.db.consumeNonce(body.nonce, body.wallet, now());
      if (!consumed) throw new ApiError(401, "NONCE_USED");
      const settled = await deps.db.decideReview(params.data.paymentId, {
        status: body.status,
        reviewerUserId: user.id,
        reviewerWallet: body.wallet,
        reviewerSignature: body.signature,
        decidedAt: new Date(now() * 1000).toISOString(),
      });
      if (settled !== "ok") {
        throw new ApiError(409, "ALREADY_DECIDED");
      }
      await audit({
        actorType: "user",
        actorId: user.id,
        action: "review.decision",
        paymentId: params.data.paymentId,
        details: { result: body.status },
      });
      return { ok: true, status: body.status };
    }),
  );

  app.get(
    "/vendors/:wallet/stats",
    guard(async (request) => {
      const user = await profile(request);
      requireRole(user, ["owner", "reviewer", "auditor"]);
      const params = z.object({ wallet: pubkey }).safeParse(request.params);
      if (!params.success) throw new ApiError(400, "VALIDATION");
      const [rows, screened] = await Promise.all([
        deps.db.listVendorPayments(params.data.wallet),
        deps.db.isScreened(params.data.wallet),
      ]);
      const stats = vendorStats(rows, screened, now() * 1000);
      return {
        total: stats.total,
        refunded: stats.refunded,
        disputed: stats.disputed,
        recentCount: stats.recentCount,
        refundRatio: stats.refundRatio,
        disputeRatio: stats.disputeRatio,
        outcome: expectedGateOutcome(stats),
      };
    }),
  );
}

async function expireReviews(
  db: HistoryRepository,
  nowSeconds: number,
  timeoutSeconds: number,
) {
  const reviews = await db.listReviews();
  for (const review of reviews) {
    if (review.status !== "pending") continue;
    const created = Math.floor(Date.parse(review.createdAt) / 1000);
    if (nowSeconds - created < timeoutSeconds) continue;
    await db.decideReview(review.paymentId, {
      status: "timed_out",
      reviewerUserId: null,
      reviewerWallet: null,
      reviewerSignature: null,
      decidedAt: new Date(nowSeconds * 1000).toISOString(),
    });
  }
}

function verifySignature(
  wallet: string,
  message: string,
  signature: string,
): boolean {
  try {
    const sig = bs58.decode(signature);
    const publicKey = bs58.decode(wallet);
    if (sig.length !== 64 || publicKey.length !== 32) return false;
    return nacl.sign.detached.verify(
      textEncoder.encode(message),
      sig,
      publicKey,
    );
  } catch {
    return false;
  }
}

function secretMatches(expected: string, got: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(got);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
