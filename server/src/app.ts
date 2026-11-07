import nacl from "tweetnacl";
import Fastify, { type FastifyInstance } from "fastify";
import {
  decodeBase58,
  decodeHex,
  encodeBase58,
  encodeHex,
  isZero,
} from "./bytes.ts";
import { evaluateFund, evaluateRelease, type Evaluation } from "./checks.ts";
import {
  CHECK_SCREENING,
  CLEARANCE_LEN,
  DECISION_ALLOW,
  DECISION_DENY,
  ED25519_PROGRAM,
  KIND_FUND,
  KIND_RELEASE,
  REQUIRED_CHECKS,
  ed25519InstructionData,
  encodeClearance,
  intentMessage,
  sha256,
  signClearance,
} from "./clearance.ts";
import { sqliteGateStore, type GateStore } from "./gate-store.ts";
import type { DatabaseSync } from "node:sqlite";
import { runProviderGate, type ProviderGateResult } from "./providers/gate.ts";
import {
  registerProviderRoutes,
  type ProviderRouteDeps,
} from "./providers/routes.ts";

const DAY_SECONDS = 86_400;
const MIN_WINDOW_SECONDS = 60;
const MAX_WINDOW_SECONDS = 14 * DAY_SECONDS;
const ISSUED_SKEW_SECONDS = 15;
const ZERO_HASH = "00".repeat(32);

type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };

export type GateOptions = {
  db?: DatabaseSync;
  store?: GateStore;
  policy: KeyPair;
  verifier: Uint8Array;
  mint: string;
  policyVersion: number;
  now?: () => number;
  clearanceTtlSeconds?: number;
  providerRoutes?: ProviderRouteDeps;
  persistHistory?: (record: {
    paymentId: string;
    buyer: string;
    vendor: string;
    amount: number;
    decision: "allow" | "deny";
    kind: "fund" | "release";
    checksRun: number;
    checksFailed: number;
    signature: string;
    expiresAt: number;
    reasons: string[];
  }) => Promise<void>;
};

export function buildApp(options: GateOptions): FastifyInstance {
  const store = options.store ?? sqliteGateStore(options.db as DatabaseSync);
  const app = Fastify({ logger: false });
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const ttl = options.clearanceTtlSeconds ?? 120;
  const configuredMint = encodeBase58(readPubkey(options.mint, "MINT"));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code, ...error.extra });
    }
    throw error;
  });

  if (options.providerRoutes) {
    registerProviderRoutes(app, options.providerRoutes);
  }

  app.get("/health", async () => ({
    ok: true,
    policySigner: encodeBase58(options.policy.publicKey),
    verifier: encodeBase58(options.verifier),
    mint: configuredMint,
    policyVersion: options.policyVersion,
    clearanceBytes: CLEARANCE_LEN,
  }));

  app.post("/vendors", async (request) => {
    const body = record(request.body);
    await store.insertVendor({
      wallet: pubkey(body.wallet, "WALLET").text,
      name: text(body.name, "NAME"),
      country: country(body.country),
      blocked: bool(body.blocked),
    });
    return { ok: true };
  });

  app.post("/corridors", async (request) => {
    const body = record(request.body);
    await store.upsertCorridor({
      fromCountry: country(body.fromCountry),
      toCountry: country(body.toCountry),
      enabled: body.enabled !== false,
      perPaymentCap: amount(body.perPaymentCap),
      dailyCap: amount(body.dailyCap),
      packetThreshold: nonNegative(body.packetThreshold ?? 0),
    });
    return { ok: true };
  });

  app.post("/mandates", async (request) => {
    const body = record(request.body);
    const corridors = readCorridors(body.corridors);
    const mandate = {
      mandateId: nonNegative(body.mandateId),
      mandate: pubkey(body.mandate, "MANDATE").text,
      owner: pubkey(body.owner, "OWNER").text,
      agent: pubkey(body.agent, "AGENT").text,
      budget: amount(body.budget),
      perPaymentLimit: amount(body.perPaymentLimit),
      maxUses: positiveInt(body.maxUses, "MAX_USES"),
      expiresAt: positiveInt(body.expiresAt, "EXPIRES_AT"),
      deliverySeconds: window(body.deliverySeconds),
      acceptanceSeconds: window(body.acceptanceSeconds),
      category: u16(body.category, "CATEGORY"),
      corridors,
    };
    if (mandate.agent === mandate.owner)
      throw new HttpError(400, "AGENT_IS_OWNER");
    if (mandate.perPaymentLimit > mandate.budget)
      throw new HttpError(400, "BAD_LIMIT");
    if (mandate.expiresAt <= now()) throw new HttpError(400, "MANDATE_EXPIRED");
    try {
      await store.insertMandate(mandate);
    } catch (error) {
      if (isUnique(error)) throw new HttpError(409, "MANDATE_EXISTS");
      throw error;
    }
    return { ok: true };
  });

  app.post("/mandates/revoke", async (request) => {
    const body = record(request.body);
    const mandateId = nonNegative(body.mandateId);
    if (!(await store.getMandate(mandateId)))
      throw new HttpError(404, "MANDATE_UNKNOWN");
    await store.revokeMandate(mandateId);
    return { ok: true };
  });

  app.post("/clearances/fund", async (request) => {
    const body = record(request.body);
    const fields = readPaymentFields(body);
    const mandate = await store.getMandate(fields.mandateId);
    const intentOk = mandate
      ? verifyIntent(KIND_FUND, fields, mandate.agent, body.intentSignature)
      : false;
    const providerResult = options.providerRoutes
      ? await runProviderGate({
          db: options.db,
          sanctions: options.providerRoutes.sanctions,
          vendor: fields.vendor.text,
          paymentId: fields.paymentId.text,
          environment: options.providerRoutes.environment,
          nowMs: now() * 1000,
        })
      : ({ ok: true } satisfies ProviderGateResult);
    if (!providerResult.ok && providerResult.unavailable) {
      throw new HttpError(503, "CHECK_UNAVAILABLE", {
        reason: providerResult.reason,
      });
    }
    const evaluation = evaluateFund({
      now: now(),
      configuredMint,
      paymentSeen: (await store.getPayment(fields.paymentId.text)) !== undefined,
      intentOk,
      mandateAccount: fields.mandate.text,
      buyer: fields.buyer.text,
      vendor: fields.vendor.text,
      vendorIsZero: isZero(fields.vendor.bytes),
      requestMint: fields.mint.text,
      amount: fields.amount,
      fromCountry: fields.fromCountry,
      toCountry: fields.toCountry,
      category: fields.category,
      invoiceAmount: fields.invoiceAmount,
      invoiceCurrency: fields.invoiceCurrency,
      packetHash: fields.packetHash.bytes,
      mandate,
      vendorRow: await store.getVendor(fields.vendor.text),
      corridor: await store.getCorridor(fields.fromCountry, fields.toCountry),
    });
    if (!providerResult.ok) {
      evaluation.ok = false;
      evaluation.checksFailed |= CHECK_SCREENING;
      for (const reason of providerResult.reasons) {
        if (!evaluation.reasons.includes(reason)) evaluation.reasons.push(reason);
      }
      if (providerResult.reasons.includes("REVIEW_STARTED")) {
        try {
          await options.providerRoutes?.enqueueReview?.({
            paymentId: fields.paymentId.text,
            wallet: fields.vendor.text,
            reasonCode: "REVIEW_STARTED",
          });
        } catch {
          throw new HttpError(503, "CHECK_UNAVAILABLE");
        }
      }
    }
    const decision = evaluation.ok ? DECISION_ALLOW : DECISION_DENY;
    if (evaluation.ok && mandate) {
      try {
        await store.commitFund(
          {
            paymentId: fields.paymentId.text,
            mandateId: fields.mandateId,
            mandate: fields.mandate.text,
            buyer: fields.buyer.text,
            agent: mandate.agent,
            vendor: fields.vendor.text,
            mint: fields.mint.text,
            amount: fields.amount,
            fromCountry: fields.fromCountry,
            toCountry: fields.toCountry,
            category: fields.category,
            purposeCode: fields.purposeCode,
            invoiceHash: fields.invoiceHash.text,
            invoiceAmount: fields.invoiceAmount,
            packetHash: fields.packetHash.text,
            state: "funded",
            receiptHash: null,
            verificationHash: null,
            deliveryDeadline: now() + mandate.deliverySeconds,
            acceptanceDeadline: 0,
          },
          Math.floor(now() / DAY_SECONDS),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "BUDGET") {
          throw new HttpError(409, "BUDGET");
        }
        throw error;
      }
    }
    return sign(options, store, {
      now: now(),
      ttl,
      kind: KIND_FUND,
      decision,
      fields,
      evaluation,
      forced: false,
    });
  });

  app.post("/payments/delivery", async (request) => {
    const body = record(request.body);
    const paymentId = hash(body.paymentId, "PAYMENT_ID").text;
    const receipt = hash(body.receiptHash, "RECEIPT_HASH").text;
    const payment = await store.getPayment(paymentId);
    if (!payment) throw new HttpError(404, "PAYMENT_UNKNOWN");
    if (payment.state !== "funded") throw new HttpError(409, "BAD_STATE");
    if (now() >= payment.deliveryDeadline)
      throw new HttpError(409, "DELIVERY_LATE");
    if (receipt === ZERO_HASH) throw new HttpError(400, "BAD_RECEIPT");
    const mandate = await store.getMandate(payment.mandateId);
    if (!mandate) throw new HttpError(404, "MANDATE_UNKNOWN");
    await store.updatePayment(paymentId, {
      state: "delivered",
      receiptHash: receipt,
      acceptanceDeadline: now() + mandate.acceptanceSeconds,
    });
    return { ok: true, state: "delivered" };
  });

  app.post("/payments/verify", async (request) => {
    const body = record(request.body);
    const paymentId = hash(body.paymentId, "PAYMENT_ID").text;
    const payment = await store.getPayment(paymentId);
    if (!payment) throw new HttpError(404, "PAYMENT_UNKNOWN");
    if (payment.state !== "delivered") throw new HttpError(409, "BAD_STATE");
    if (now() >= payment.acceptanceDeadline)
      throw new HttpError(409, "ACCEPTANCE_CLOSED");
    const artifact = artifactBytes(body.artifact);
    const digest = encodeHex(sha256(artifact));
    if (digest !== payment.receiptHash) throw new HttpError(400, "BAD_RECEIPT");
    await store.updatePayment(paymentId, {
      state: "verified",
      verificationHash: digest,
    });
    return { ok: true, state: "verified", verificationHash: digest };
  });

  app.post("/clearances/release", async (request) => {
    const body = record(request.body);
    const paymentId = hash(body.paymentId, "PAYMENT_ID").text;
    const payment = await store.getPayment(paymentId);
    if (!payment) throw new HttpError(404, "PAYMENT_UNKNOWN");
    const dispute = bool(body.dispute);
    const fields = fieldsFromPayment(payment);
    const intentOk = verifyIntent(
      KIND_RELEASE,
      fields,
      payment.agent,
      body.intentSignature
    );
    if (!intentOk) throw new HttpError(401, "INTENT_SIG");
    if (dispute) {
      if (
        payment.state !== "funded" &&
        payment.state !== "delivered" &&
        payment.state !== "verified"
      ) {
        throw new HttpError(409, "BAD_STATE");
      }
      await store.updatePayment(paymentId, { state: "disputed" });
      return sign(options, store, {
        now: now(),
        ttl,
        kind: KIND_RELEASE,
        decision: DECISION_DENY,
        fields,
        evaluation: {
          ok: false,
          reasons: ["DISPUTE"],
          checksRun: REQUIRED_CHECKS,
          checksFailed: 0,
        },
        forced: false,
      });
    }
    const vendorBytes = decodeBase58(payment.vendor);
    const evaluation = evaluateRelease({
      now: now(),
      configuredMint,
      intentOk,
      vendorIsZero: isZero(vendorBytes),
      payment: await store.getPayment(paymentId),
      vendorRow: await store.getVendor(payment.vendor),
      corridor: await store.getCorridor(payment.fromCountry, payment.toCountry),
    });
    if (!evaluation.ok) {
      await store.insertEvidence({
        createdAt: now(),
        kind: "release",
        decision: "deny",
        paymentId: payment.paymentId,
        mandate: payment.mandate,
        buyer: payment.buyer,
        vendor: payment.vendor,
        amount: payment.amount,
        reasons: evaluation.reasons,
        checksRun: evaluation.checksRun,
        checksFailed: evaluation.checksFailed,
        clearanceHash: "",
        forced: false,
      });
      throw new HttpError(409, evaluation.reasons[0] ?? "DENY", {
        decision: "deny",
        signed: false,
        reasons: evaluation.reasons,
        checksRun: evaluation.checksRun,
        checksFailed: evaluation.checksFailed,
      });
    }
    const signed = sign(options, store, {
      now: now(),
      ttl,
      kind: KIND_RELEASE,
      decision: DECISION_ALLOW,
      fields,
      evaluation,
      forced: false,
    });
    return signed;
  });

  app.post("/demo/force-clearance", async (request) => {
    const body = record(request.body);
    const fields = readPaymentFields(body);
    const kind =
      body.kind === "release"
        ? KIND_RELEASE
        : body.kind === "fund"
          ? KIND_FUND
          : 0;
    if (!kind) throw new HttpError(400, "BAD_KIND");
    const decision =
      body.decision === "deny"
        ? DECISION_DENY
        : body.decision === "allow"
          ? DECISION_ALLOW
          : -1;
    if (decision < 0) throw new HttpError(400, "BAD_DECISION");
    return sign(options, store, {
      now: now(),
      ttl,
      kind,
      decision,
      fields,
      evaluation: {
        ok: decision === DECISION_ALLOW,
        reasons: ["FORCED"],
        checksRun: REQUIRED_CHECKS,
        checksFailed: 0,
      },
      forced: true,
    });
  });

  app.get("/evidence/:paymentId", async (request) => {
    const params = request.params as { paymentId: string };
    const paymentId = hash(params.paymentId, "PAYMENT_ID").text;
    const providerChecks = await store.listProviderChecks(paymentId);
    const notes = providerChecks
      .map((check) => check.publicNote)
      .filter((note) => note.length > 0);
    return {
      evidence: await store.listEvidence(paymentId),
      providerChecks,
      notes,
    };
  });

  return app;
}

async function sign(
  options: GateOptions,
  store: GateStore,
  input: {
    now: number;
    ttl: number;
    kind: number;
    decision: number;
    fields: PaymentFields;
    evaluation: Evaluation;
    forced: boolean;
  }
) {
  const message = encodeClearance({
    kind: input.kind,
    decision: input.decision,
    paymentId: input.fields.paymentId.bytes,
    mandate: input.fields.mandate.bytes,
    buyer: input.fields.buyer.bytes,
    vendor: input.fields.vendor.bytes,
    mint: input.fields.mint.bytes,
    amount: input.fields.amount,
    fromCountry: input.fields.fromCountry,
    toCountry: input.fields.toCountry,
    category: input.fields.category,
    purposeCode: input.fields.purposeCode,
    invoiceHash: input.fields.invoiceHash.bytes,
    invoiceAmount: input.fields.invoiceAmount,
    policyVersion: options.policyVersion,
    issuedAt: input.now - ISSUED_SKEW_SECONDS,
    expiresAt: input.now + input.ttl,
    checksRun: input.evaluation.checksRun,
    checksFailed: input.evaluation.checksFailed,
    packetHash: input.fields.packetHash.bytes,
  });
  const signature = signClearance(message, options.policy.secretKey);
  const result = {
    decision: input.decision === DECISION_ALLOW ? "allow" : "deny",
    signed: true,
    reasons: input.evaluation.reasons,
    checksRun: input.evaluation.checksRun,
    checksFailed: input.evaluation.checksFailed,
    message: Buffer.from(message).toString("base64"),
    signature: Buffer.from(signature).toString("base64"),
    signer: encodeBase58(options.policy.publicKey),
    ed25519Program: ED25519_PROGRAM,
    instructionData: Buffer.from(
      ed25519InstructionData(signature, options.policy.publicKey, message)
    ).toString("base64"),
    evidenceId: 0,
    clearanceHash: encodeHex(sha256(message)),
  };
  const evidenceId = await store.insertEvidence({
    createdAt: input.now,
    kind: input.kind === KIND_FUND ? "fund" : "release",
    decision: input.decision === DECISION_ALLOW ? "allow" : "deny",
    paymentId: input.fields.paymentId.text,
    mandate: input.fields.mandate.text,
    buyer: input.fields.buyer.text,
    vendor: input.fields.vendor.text,
    amount: input.fields.amount,
    reasons: input.evaluation.reasons,
    checksRun: input.evaluation.checksRun,
    checksFailed: input.evaluation.checksFailed,
    clearanceHash: encodeHex(sha256(message)),
    forced: input.forced,
  });
  result.evidenceId = evidenceId;
  if (!options.persistHistory) return result;
  return options
    .persistHistory({
      paymentId: input.fields.paymentId.text,
      buyer: input.fields.buyer.text,
      vendor: input.fields.vendor.text,
      amount: input.fields.amount,
      decision: result.decision,
      kind: input.kind === KIND_FUND ? "fund" : "release",
      checksRun: input.evaluation.checksRun,
      checksFailed: input.evaluation.checksFailed,
      signature: result.signature,
      expiresAt: input.now + input.ttl,
      reasons: input.evaluation.reasons,
    })
    .then(
      () => result,
      () => {
        throw new HttpError(503, "CHECK_UNAVAILABLE");
      }
    );
}

type Pub = { text: string; bytes: Uint8Array };

type PaymentFields = {
  mandateId: number;
  paymentId: Pub;
  mandate: Pub;
  buyer: Pub;
  vendor: Pub;
  mint: Pub;
  amount: number;
  fromCountry: string;
  toCountry: string;
  category: number;
  purposeCode: number;
  invoiceHash: Pub;
  invoiceAmount: number;
  invoiceCurrency: string;
  packetHash: Pub;
};

function readPaymentFields(body: Record<string, unknown>): PaymentFields {
  const invoiceCurrency = text(body.invoiceCurrency, "CURRENCY");
  return {
    mandateId: nonNegative(body.mandateId),
    paymentId: hash(body.paymentId, "PAYMENT_ID"),
    mandate: pubkey(body.mandate, "MANDATE"),
    buyer: pubkey(body.buyer, "BUYER"),
    vendor: pubkey(body.vendor, "VENDOR"),
    mint: pubkey(body.mint, "MINT"),
    amount: amount(body.amount),
    fromCountry: country(body.fromCountry),
    toCountry: country(body.toCountry),
    category: u16(body.category, "CATEGORY"),
    purposeCode: u16(body.purposeCode, "PURPOSE"),
    invoiceHash: hash(body.invoiceHash, "INVOICE_HASH"),
    invoiceAmount: amount(body.invoiceAmount),
    invoiceCurrency,
    packetHash:
      body.packetHash === undefined
        ? hash(ZERO_HASH, "PACKET_HASH")
        : hash(body.packetHash, "PACKET_HASH"),
  };
}

function fieldsFromPayment(
  payment: NonNullable<ReturnType<typeof getPayment>>
): PaymentFields {
  return {
    mandateId: payment.mandateId,
    paymentId: hash(payment.paymentId, "PAYMENT_ID"),
    mandate: pubkey(payment.mandate, "MANDATE"),
    buyer: pubkey(payment.buyer, "BUYER"),
    vendor: pubkey(payment.vendor, "VENDOR"),
    mint: pubkey(payment.mint, "MINT"),
    amount: payment.amount,
    fromCountry: payment.fromCountry,
    toCountry: payment.toCountry,
    category: payment.category,
    purposeCode: payment.purposeCode,
    invoiceHash: hash(payment.invoiceHash, "INVOICE_HASH"),
    invoiceAmount: payment.invoiceAmount,
    invoiceCurrency: "USD",
    packetHash: hash(payment.packetHash, "PACKET_HASH"),
  };
}

function verifyIntent(
  kind: number,
  fields: PaymentFields,
  agent: string,
  signature: unknown
): boolean {
  if (typeof signature !== "string") return false;
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return false;
  let agentBytes: Uint8Array;
  try {
    agentBytes = decodeBase58(agent);
  } catch {
    return false;
  }
  const message = intentMessage({
    kind,
    paymentId: fields.paymentId.bytes,
    mandate: fields.mandate.bytes,
    buyer: fields.buyer.bytes,
    vendor: fields.vendor.bytes,
    mint: fields.mint.bytes,
    amount: fields.amount,
    fromCountry: fields.fromCountry,
    toCountry: fields.toCountry,
    category: fields.category,
    purposeCode: fields.purposeCode,
    invoiceHash: fields.invoiceHash.bytes,
    invoiceAmount: fields.invoiceAmount,
  });
  return nacl.sign.detached.verify(message, sig, agentBytes);
}

function artifactBytes(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new HttpError(400, "BAD_RECEIPT");
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (bytes.length < 4 || bytes.length > 256)
    throw new HttpError(400, "BAD_RECEIPT");
  if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "DLV1") {
    throw new HttpError(400, "BAD_RECEIPT");
  }
  return bytes;
}

class HttpError extends Error {
  statusCode: number;
  code: string;
  extra: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    extra: Record<string, unknown> = {}
  ) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "BAD_BODY");
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 120)
    throw new HttpError(400, code);
  return value;
}

function pubkey(value: unknown, code: string): Pub {
  try {
    const bytes = readPubkey(text(value, code), code);
    return { text: encodeBase58(bytes), bytes };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, code);
  }
}

function readPubkey(value: string, code: string): Uint8Array {
  try {
    const bytes = decodeBase58(value);
    if (bytes.length !== 32) throw new Error("width");
    return bytes;
  } catch {
    throw new HttpError(400, code);
  }
}

function hash(value: unknown, code: string): Pub {
  if (typeof value !== "string") throw new HttpError(400, code);
  try {
    const bytes = decodeHex(value, 32);
    return { text: encodeHex(bytes), bytes };
  } catch {
    throw new HttpError(400, code);
  }
}

function country(value: unknown): string {
  const code = text(value, "BAD_COUNTRY").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new HttpError(400, "BAD_COUNTRY");
  return code;
}

function amount(value: unknown): number {
  return positiveInt(value, "BAD_AMOUNT");
}

function nonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, "BAD_NUMBER");
  }
  return value;
}

function positiveInt(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, code);
  }
  return value;
}

function u16(value: unknown, code: string): number {
  const number = nonNegative(value);
  if (number > 0xffff) throw new HttpError(400, code);
  return number;
}

function window(value: unknown): number {
  const seconds = positiveInt(value, "BAD_WINDOW");
  if (seconds < MIN_WINDOW_SECONDS || seconds > MAX_WINDOW_SECONDS)
    throw new HttpError(400, "BAD_WINDOW");
  return seconds;
}

function bool(value: unknown): boolean {
  return value === true;
}

function readCorridors(
  value: unknown
): { fromCountry: string; toCountry: string }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new HttpError(400, "BAD_CORRIDORS");
  }
  return value.map((item) => {
    const row = record(item);
    return {
      fromCountry: country(row.fromCountry),
      toCountry: country(row.toCountry),
    };
  });
}

function isUnique(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE");
}
