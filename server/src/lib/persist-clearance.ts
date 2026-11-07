import { randomUUID } from "node:crypto";
import type { HistoryStatus } from "./outcomes.ts";
import type { HistoryRepository } from "./repository.ts";

export type StoredClearance = {
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
};

export function persistClearance(db: HistoryRepository, policyVersion: number) {
  return async (record: StoredClearance) => {
    const createdAt = new Date().toISOString();
    let status: HistoryStatus = "funded";
    if (record.kind === "release" && record.decision === "allow") {
      status = "released";
    }
    if (record.reasons.includes("DISPUTE")) status = "disputed";
    await db.upsertPayment({
      paymentId: record.paymentId,
      buyer: record.buyer,
      vendor: record.vendor,
      amountUsdc: String(record.amount),
      status,
      createdAt,
    });
    await db.upsertClearance({
      paymentId: record.paymentId,
      decision: record.decision,
      checksRun: String(record.checksRun),
      checksFailed: String(record.checksFailed),
      policyVersion: String(policyVersion),
      listVersion: "1",
      expiresAt: new Date(record.expiresAt * 1000).toISOString(),
      signature: record.signature,
      createdAt,
    });
    const reasons = record.reasons.length > 0 ? record.reasons : [""];
    for (const reason of reasons) {
      await db.insertCheck({
        id: randomUUID(),
        paymentId: record.paymentId,
        checkId: reason || "bundle",
        status: reason ? "fail" : "pass",
        reasonCode: reason,
        evidenceHash: "",
        createdAt,
      });
    }
  };
}
