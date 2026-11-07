import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ApiError } from "../lib/api-error.ts";
import type { Profile } from "../lib/repository.ts";
import { requireProfile, requireRole } from "../middleware/dashboard.ts";
import { randomUUID } from "node:crypto";
import {
  getIdentity,
  insertLocalAudit,
  insertWebhookEvent,
  upsertIdentity,
} from "../db.ts";
import { ProviderHttpError } from "./http.ts";
import type {
  IdentityVerificationProvider,
  SanctionsScreeningProvider,
} from "./types.ts";

const pubkey = z.string().min(32).max(64);

export type ProviderRouteDeps = {
  db: DatabaseSync;
  sanctions: SanctionsScreeningProvider;
  identity: IdentityVerificationProvider;
  environment: string;
  now?: () => number;
  audit?: (entry: {
    sessionId: string;
    status: string;
    wallet: string;
  }) => Promise<void>;
  enqueueReview?: (entry: {
    paymentId: string;
    wallet: string;
    reasonCode: string;
  }) => Promise<void>;
  getDashboardUser?: (
    token: string,
  ) => Promise<{ id: string; email: string } | null>;
  getProfile?: (userId: string) => Promise<Profile | null>;
};

export function registerProviderRoutes(
  app: FastifyInstance,
  deps: ProviderRouteDeps,
): void {
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);

  app.get("/health/providers", async () => {
    const sanctions = await deps.sanctions.health();
    const identity = await reach(() => deps.identity.ping());
    return {
      sanctions: { reachable: sanctions },
      identity: { reachable: identity },
    };
  });

  app.post("/vendors/:wallet/verification", async (request, reply) => {
    try {
      const user = await owner(request);
      requireRole(user, ["owner"]);
      const params = z.object({ wallet: pubkey }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "VALIDATION" });
      const session = await deps.identity.createSession(params.data.wallet);
      upsertIdentity(deps.db, {
        vendorWallet: params.data.wallet,
        provider: "didit",
        sessionId: session.sessionId,
        status: session.status,
        expiresAt: null,
        updatedAt: new Date(now() * 1000).toISOString(),
      });
      return { url: session.url, sessionId: session.sessionId };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.register(async (scope) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => {
        done(null, body);
      },
    );
    scope.post("/webhooks/didit", async (request, reply) => {
      const raw = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(request.body as Uint8Array);
      const verdict = deps.identity.parseWebhook(request.headers, raw, now());
      if (!verdict.ok) return reply.code(401).send({ error: verdict.code });
      const fresh = insertWebhookEvent(deps.db, {
        id: verdict.eventId,
        provider: "didit",
        sessionId: verdict.sessionId,
        receivedAt: new Date(now() * 1000).toISOString(),
      });
      if (!fresh) return reply.code(401).send({ error: "REPLAYED" });
      const outcome = {
        provider: "didit",
        sessionId: verdict.sessionId,
        status: verdict.status,
        wallet: verdict.vendorWallet,
      };
      insertLocalAudit(deps.db, {
        id: randomUUID(),
        actorType: "system",
        actorId: "didit",
        action: "identity.webhook",
        paymentId: null,
        details: outcome,
        createdAt: new Date(now() * 1000).toISOString(),
      });
      await deps.audit?.(outcome);
      const current = getIdentity(deps.db, verdict.vendorWallet);
      if (
        current?.sessionId === verdict.sessionId &&
        current.status === verdict.status
      ) {
        return { ok: true, idempotent: true };
      }
      upsertIdentity(deps.db, {
        vendorWallet: verdict.vendorWallet,
        provider: "didit",
        sessionId: verdict.sessionId,
        status: verdict.status,
        expiresAt: verdict.expiresAt,
        updatedAt: new Date(now() * 1000).toISOString(),
      });
      return { ok: true };
    });
  });

  async function owner(request: FastifyRequest): Promise<Profile> {
    if (!deps.getDashboardUser || !deps.getProfile) {
      throw new ApiError(401, "UNAUTHORIZED");
    }
    return requireProfile(request, deps.getDashboardUser, deps.getProfile);
  }
}

async function reach(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (
      error instanceof ProviderHttpError &&
      (error.code === "HTTP" || error.code === "MALFORMED")
    ) {
      return true;
    }
    return false;
  }
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiError) {
    return reply.code(error.statusCode).send({ error: error.code });
  }
  return reply.code(503).send({ error: "CHECK_UNAVAILABLE" });
}
