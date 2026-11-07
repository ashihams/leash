import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  getIdentity,
  insertProviderCheck,
  type IdentityRow,
} from "../db.ts";
import { evidenceHash } from "./evidence.ts";
import { ProviderHttpError } from "./http.ts";
import { identityCheck } from "./identity.ts";
import { OfacScreenError } from "./ofac.ts";
import type { SanctionsScreeningProvider } from "./types.ts";

export type ProviderGateResult =
  | { ok: true }
  | { ok: false; unavailable: true; reason: string }
  | {
      ok: false;
      unavailable: false;
      reasons: string[];
      checkStatus: "fail" | "flag";
    };

export async function runProviderGate(input: {
  db: DatabaseSync;
  sanctions: SanctionsScreeningProvider;
  vendor: string;
  paymentId: string;
  environment: string;
  nowMs: number;
}): Promise<ProviderGateResult> {
  const createdAt = new Date(input.nowMs).toISOString();
  let sanctionsStatus: "pass" | "flag" | "fail" = "fail";
  let sanctionsReason = "CHECK_UNAVAILABLE";
  let sanctionsHash = evidenceHash({ error: "CHECK_UNAVAILABLE" });
  let sanctionsNote = "";
  let unavailableReason = "CHECK_UNAVAILABLE";
  try {
    const screened = await input.sanctions.screenWallet(input.vendor);
    sanctionsHash = evidenceHash(screened.raw);
    sanctionsNote = publicNote(screened.raw);
    if (screened.listed) {
      sanctionsStatus = "fail";
      sanctionsReason = "LIST_MATCH_WALLET";
    } else {
      sanctionsStatus = "pass";
      sanctionsReason = "";
    }
  } catch (error) {
    if (error instanceof OfacScreenError) {
      if (error.code === "PARAMS_INVALID") {
        sanctionsStatus = "fail";
        sanctionsReason = "PARAMS_INVALID";
      } else if (error.code === "LIST_STALE") {
        sanctionsReason = "LIST_STALE";
        unavailableReason = "LIST_STALE";
      } else {
        sanctionsReason = "CHECK_UNAVAILABLE";
        unavailableReason = "CHECK_UNAVAILABLE";
      }
    } else if (!(error instanceof ProviderHttpError)) {
      throw error;
    }
  }
  record(input, {
    paymentId: input.paymentId,
    wallet: input.vendor,
    checkId: "sanctions",
    status: sanctionsStatus,
    reasonCode: sanctionsReason,
    evidenceHash: sanctionsHash,
    provider: "ofac",
    environment: input.environment,
    publicNote: sanctionsNote,
    createdAt,
  });
  if (sanctionsReason === "CHECK_UNAVAILABLE" || sanctionsReason === "LIST_STALE") {
    return { ok: false, unavailable: true, reason: unavailableReason };
  }

  const identity = getIdentity(input.db, input.vendor);
  const identityResult = identityCheck({
    record: identity
      ? { status: identity.status, expiresAt: identity.expiresAt }
      : null,
    nowMs: input.nowMs,
  });
  record(input, {
    paymentId: input.paymentId,
    wallet: input.vendor,
    checkId: "identity",
    status: identityResult.status,
    reasonCode: identityResult.reasonCode,
    evidenceHash: evidenceHash(identitySummary(identity)),
    provider: "didit",
    environment: input.environment,
    createdAt,
  });

  const reasons = [sanctionsReason, identityResult.reasonCode].filter(
    (reason) => reason.length > 0,
  );
  const flagged =
    sanctionsStatus === "flag" || identityResult.status === "flag";
  const failed = sanctionsStatus === "fail" || identityResult.status === "fail";
  if (!failed && !flagged) return { ok: true };
  return {
    ok: false,
    unavailable: false,
    reasons,
    checkStatus: failed ? "fail" : "flag",
  };
}

function publicNote(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const record = raw as Record<string, unknown>;
  if (typeof record.statement === "string") return record.statement;
  if (typeof record.sdn_entry_id === "string") {
    return `sdn_entry_id ${record.sdn_entry_id}, currency ${String(record.currency)}, sha256 ${String(record.sha256)}`;
  }
  return "";
}

function identitySummary(row: IdentityRow | undefined) {
  if (!row) return { present: false };
  return {
    present: true,
    provider: row.provider,
    sessionId: row.sessionId,
    status: row.status,
    expiresAt: row.expiresAt,
  };
}

function record(
  input: { db: DatabaseSync },
  row: {
    paymentId: string;
    wallet: string;
    checkId: string;
    status: string;
    reasonCode: string;
    evidenceHash: string;
    provider: string;
    environment: string;
    publicNote?: string;
    createdAt: string;
  },
) {
  insertProviderCheck(input.db, { id: randomUUID(), ...row });
}
