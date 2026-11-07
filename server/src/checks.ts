import {
  CHECK_BUYER_AUTH,
  CHECK_CATEGORY,
  CHECK_CORRIDOR,
  CHECK_INTENT_SIG,
  CHECK_MANDATE,
  CHECK_MINT,
  CHECK_NONCE,
  CHECK_NOT_SELF,
  CHECK_SCREENING,
  CHECK_VELOCITY,
  CHECK_VENDOR_AUTH,
  CHECK_VENDOR_REGISTERED,
  REQUIRED_CHECKS,
  packetMissing,
} from "./clearance.ts";
import type { CorridorRow, MandateRow, PaymentRow, VendorRow } from "./db.ts";

export type Evaluation = {
  ok: boolean;
  reasons: string[];
  checksRun: number;
  checksFailed: number;
};

export type FundFacts = {
  now: number;
  configuredMint: string;
  paymentSeen: boolean;
  intentOk: boolean;
  mandateAccount: string;
  buyer: string;
  vendor: string;
  vendorIsZero: boolean;
  requestMint: string;
  amount: number;
  fromCountry: string;
  toCountry: string;
  category: number;
  invoiceAmount: number;
  invoiceCurrency: string;
  packetHash: Uint8Array;
  mandate?: MandateRow;
  vendorRow?: VendorRow;
  corridor?: CorridorRow;
};

export type ReleaseFacts = {
  now: number;
  configuredMint: string;
  intentOk: boolean;
  vendorIsZero: boolean;
  payment?: PaymentRow;
  vendorRow?: VendorRow;
  corridor?: CorridorRow;
};

// The screening bit is a local vendor block list. It is not sanctions, KYC, or AML.
export function evaluateFund(facts: FundFacts): Evaluation {
  return evaluate((fail) => {
    const mandate = facts.mandate;
    if (
      !mandate ||
      mandate.mandate !== facts.mandateAccount ||
      mandate.owner !== facts.buyer
    ) {
      fail(CHECK_BUYER_AUTH, "BUYER_AUTH");
    }
    if (facts.vendorIsZero) fail(CHECK_VENDOR_AUTH, "VENDOR_AUTH");
    if (facts.paymentSeen) fail(CHECK_NONCE, "NONCE");
    if (!facts.intentOk) fail(CHECK_INTENT_SIG, "INTENT_SIG");
    if (!facts.vendorRow) fail(CHECK_VENDOR_REGISTERED, "VENDOR_REGISTERED");
    if (facts.vendorRow?.blocked) fail(CHECK_SCREENING, "VENDOR_BLOCKED");
    if (!facts.vendorRow) fail(CHECK_SCREENING, "VENDOR_BLOCKED");

    if (!mandate) {
      fail(CHECK_MANDATE, "MANDATE_UNKNOWN");
    } else {
      if (mandate.revoked) fail(CHECK_MANDATE, "MANDATE_REVOKED");
      if (facts.now >= mandate.expiresAt)
        fail(CHECK_MANDATE, "MANDATE_EXPIRED");
      if (facts.amount > mandate.perPaymentLimit)
        fail(CHECK_MANDATE, "PAYMENT_LIMIT");
      if (mandate.spent + facts.amount > mandate.budget)
        fail(CHECK_MANDATE, "BUDGET");
      if (mandate.uses >= mandate.maxUses) fail(CHECK_MANDATE, "USE_LIMIT");
      const allowed = mandate.corridors.some(
        (corridor) =>
          corridor.fromCountry === facts.fromCountry &&
          corridor.toCountry === facts.toCountry
      );
      if (!allowed) fail(CHECK_MANDATE, "CORRIDOR_NOT_ALLOWED");
      if (facts.category !== mandate.category) fail(CHECK_CATEGORY, "CATEGORY");
      if (facts.buyer === facts.vendor || mandate.agent === facts.vendor) {
        fail(CHECK_NOT_SELF, "SELF_PAYMENT");
      }
    }

    if (facts.requestMint !== facts.configuredMint) fail(CHECK_MINT, "MINT");
    if (
      facts.invoiceAmount !== facts.amount ||
      facts.invoiceCurrency !== "USD"
    ) {
      fail(0, "FX_MISMATCH");
    }

    const corridor = facts.corridor;
    if (!corridor) fail(CHECK_CORRIDOR, "CORRIDOR_UNKNOWN");
    else if (!corridor.enabled) fail(CHECK_CORRIDOR, "CORRIDOR_BLOCKED");
    if (
      corridor &&
      packetMissing(facts.packetHash, facts.amount, corridor.packetThreshold)
    ) {
      fail(CHECK_CORRIDOR, "PACKET_REQUIRED");
    }
    if (corridor && facts.amount > corridor.perPaymentCap)
      fail(CHECK_VELOCITY, "CORRIDOR_LIMIT");
    if (corridor) {
      const day = Math.floor(facts.now / 86_400);
      const spent = corridor.spentDay === day ? corridor.dailySpent : 0;
      if (spent + facts.amount > corridor.dailyCap)
        fail(CHECK_VELOCITY, "DAILY_CAP");
    }
  });
}

export function evaluateRelease(facts: ReleaseFacts): Evaluation {
  return evaluate((fail) => {
    const payment = facts.payment;
    if (!payment) fail(CHECK_BUYER_AUTH, "PAYMENT_UNKNOWN");
    if (facts.vendorIsZero) fail(CHECK_VENDOR_AUTH, "VENDOR_AUTH");
    if (!payment) fail(CHECK_NONCE, "PAYMENT_UNKNOWN");
    if (!facts.intentOk) fail(CHECK_INTENT_SIG, "INTENT_SIG");
    if (!facts.vendorRow) fail(CHECK_VENDOR_REGISTERED, "VENDOR_REGISTERED");
    if (!payment) fail(CHECK_MANDATE, "PAYMENT_UNKNOWN");
    else if (payment.state !== "verified") fail(CHECK_MANDATE, "NOT_VERIFIED");
    else if (facts.now >= payment.acceptanceDeadline)
      fail(CHECK_MANDATE, "ACCEPTANCE_CLOSED");
    if (payment && payment.mint !== facts.configuredMint)
      fail(CHECK_MINT, "MINT");
    if (
      payment &&
      (payment.buyer === payment.vendor || payment.agent === payment.vendor)
    ) {
      fail(CHECK_NOT_SELF, "SELF_PAYMENT");
    }
    const corridor = facts.corridor;
    if (!corridor) fail(CHECK_CORRIDOR, "CORRIDOR_UNKNOWN");
    else if (!corridor.enabled) fail(CHECK_CORRIDOR, "CORRIDOR_BLOCKED");
    if (!facts.vendorRow || facts.vendorRow.blocked)
      fail(CHECK_SCREENING, "VENDOR_BLOCKED");
  });
}

function evaluate(
  run: (fail: (bit: number, reason: string) => void) => void
): Evaluation {
  const reasons: string[] = [];
  let checksFailed = 0;
  const fail = (bit: number, reason: string) => {
    if (!reason) return;
    checksFailed |= bit;
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  run(fail);
  return {
    ok: reasons.length === 0,
    reasons,
    checksRun: REQUIRED_CHECKS,
    checksFailed,
  };
}
