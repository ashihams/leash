import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sqliteProviderStore, type ProviderStore } from "./store.ts";
import { evidenceHash } from "./evidence.ts";
import { OfacScreenError } from "./ofac.ts";
import type {
  IdentityVerificationProvider,
  SanctionsScreeningProvider,
} from "./types.ts";

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
  db?: DatabaseSync;
  store?: ProviderStore;
  identity: IdentityVerificationProvider;
  sanctions: SanctionsScreeningProvider;
  vendor: string;
  paymentId: string;
  environment: string;
  nowMs: number;
}): Promise<ProviderGateResult> {
  const store =
    input.store ?? (input.db ? sqliteProviderStore(input.db) : undefined);
  if (!store)
    return { ok: false, unavailable: true, reason: "CHECK_UNAVAILABLE" };
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
    } else {
      sanctionsReason = "CHECK_UNAVAILABLE";
      unavailableReason = "CHECK_UNAVAILABLE";
    }
  }
  await record(store, {
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
  if (
    sanctionsReason === "CHECK_UNAVAILABLE" ||
    sanctionsReason === "LIST_STALE"
  ) {
    return { ok: false, unavailable: true, reason: unavailableReason };
  }

  if (sanctionsStatus === "pass") return { ok: true };
  return {
    ok: false,
    unavailable: false,
    reasons: [sanctionsReason],
    checkStatus: "fail",
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

async function record(
  store: ProviderStore,
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
  }
) {
  await store.insertCheck({ id: randomUUID(), ...row });
}
