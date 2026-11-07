import type { DatabaseSync } from "node:sqlite";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CorridorRow, EvidenceInput, MandateRow, PaymentRow, VendorRow } from "./db.ts";
import {
  commitCorridorSpend,
  commitSpend,
  getCorridor,
  getMandate,
  getPayment,
  getVendor,
  insertEvidence,
  insertMandate,
  insertPayment,
  insertVendor,
  listEvidence,
  listProviderChecks,
  revokeMandate,
  transaction,
  updatePayment,
  upsertCorridor,
} from "./db.ts";

export type GateStore = {
  insertVendor(vendor: {
    wallet: string;
    name: string;
    country: string;
    blocked: boolean;
  }): Promise<void>;
  getVendor(wallet: string): Promise<VendorRow | undefined>;
  insertMandate(mandate: Omit<MandateRow, "spent" | "uses" | "revoked">): Promise<void>;
  getMandate(mandateId: number): Promise<MandateRow | undefined>;
  revokeMandate(mandateId: number): Promise<void>;
  upsertCorridor(corridor: Omit<CorridorRow, "dailySpent" | "spentDay">): Promise<void>;
  getCorridor(fromCountry: string, toCountry: string): Promise<CorridorRow | undefined>;
  commitFund(payment: PaymentRow, day: number): Promise<void>;
  getPayment(paymentId: string): Promise<PaymentRow | undefined>;
  updatePayment(
    paymentId: string,
    patch: Partial<
      Pick<PaymentRow, "state" | "receiptHash" | "verificationHash" | "acceptanceDeadline">
    >,
  ): Promise<void>;
  insertEvidence(evidence: EvidenceInput): Promise<number>;
  listEvidence(paymentId: string): Promise<ReturnType<typeof listEvidence>>;
  listProviderChecks(paymentId: string): Promise<ReturnType<typeof listProviderChecks>>;
};

export function sqliteGateStore(db: DatabaseSync): GateStore {
  return {
    async insertVendor(vendor) {
      insertVendor(db, vendor);
    },
    async getVendor(wallet) {
      return getVendor(db, wallet);
    },
    async insertMandate(mandate) {
      insertMandate(db, mandate);
    },
    async getMandate(mandateId) {
      return getMandate(db, mandateId);
    },
    async revokeMandate(mandateId) {
      revokeMandate(db, mandateId);
    },
    async upsertCorridor(corridor) {
      upsertCorridor(db, corridor);
    },
    async getCorridor(fromCountry, toCountry) {
      return getCorridor(db, fromCountry, toCountry);
    },
    async commitFund(payment, day) {
      transaction(db, () => {
        const fresh = getMandate(db, payment.mandateId);
        const seen = getPayment(db, payment.paymentId);
        if (
          !fresh ||
          seen ||
          fresh.spent + payment.amount > fresh.budget ||
          fresh.uses >= fresh.maxUses
        ) {
          throw new Error("BUDGET");
        }
        commitSpend(db, payment.mandateId, payment.amount);
        commitCorridorSpend(db, payment.fromCountry, payment.toCountry, payment.amount, day);
        insertPayment(db, payment);
      });
    },
    async getPayment(paymentId) {
      return getPayment(db, paymentId);
    },
    async updatePayment(paymentId, patch) {
      updatePayment(db, paymentId, patch);
    },
    async insertEvidence(evidence) {
      return insertEvidence(db, evidence);
    },
    async listEvidence(paymentId) {
      return listEvidence(db, paymentId);
    },
    async listProviderChecks(paymentId) {
      return listProviderChecks(db, paymentId);
    },
  };
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function must<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export function supabaseGateStore(client: SupabaseClient): GateStore {
  return {
    async insertVendor(vendor) {
      must(
        await client.from("gate_vendors").upsert({
          wallet: vendor.wallet,
          name: vendor.name,
          country: vendor.country,
          blocked: vendor.blocked ? 1 : 0,
        }),
      );
    },
    async getVendor(wallet) {
      const result = await client
        .from("gate_vendors")
        .select("wallet, name, country, blocked")
        .eq("wallet", wallet)
        .maybeSingle();
      const row = must(result);
      if (!row) return undefined;
      return {
        wallet: row.wallet,
        name: row.name,
        country: row.country,
        blocked: num(row.blocked),
      };
    },
    async insertMandate(mandate) {
      must(
        await client.from("gate_mandates").insert({
          mandate_id: mandate.mandateId,
          mandate: mandate.mandate,
          owner: mandate.owner,
          agent: mandate.agent,
          budget: mandate.budget,
          spent: 0,
          per_payment_limit: mandate.perPaymentLimit,
          max_uses: mandate.maxUses,
          uses: 0,
          expires_at: mandate.expiresAt,
          delivery_seconds: mandate.deliverySeconds,
          acceptance_seconds: mandate.acceptanceSeconds,
          category: mandate.category,
          revoked: 0,
          corridors: mandate.corridors,
        }),
      );
    },
    async getMandate(mandateId) {
      const result = await client
        .from("gate_mandates")
        .select("*")
        .eq("mandate_id", mandateId)
        .maybeSingle();
      const row = must(result);
      if (!row) return undefined;
      return {
        mandateId: num(row.mandate_id),
        mandate: row.mandate,
        owner: row.owner,
        agent: row.agent,
        budget: num(row.budget),
        spent: num(row.spent),
        perPaymentLimit: num(row.per_payment_limit),
        maxUses: num(row.max_uses),
        uses: num(row.uses),
        expiresAt: num(row.expires_at),
        deliverySeconds: num(row.delivery_seconds),
        acceptanceSeconds: num(row.acceptance_seconds),
        category: num(row.category),
        revoked: num(row.revoked),
        corridors: row.corridors,
      };
    },
    async revokeMandate(mandateId) {
      must(
        await client.from("gate_mandates").update({ revoked: 1 }).eq("mandate_id", mandateId),
      );
    },
    async upsertCorridor(corridor) {
      const existing = await this.getCorridor(corridor.fromCountry, corridor.toCountry);
      must(
        await client.from("gate_corridors").upsert({
          from_country: corridor.fromCountry,
          to_country: corridor.toCountry,
          enabled: corridor.enabled ? 1 : 0,
          per_payment_cap: corridor.perPaymentCap,
          daily_cap: corridor.dailyCap,
          daily_spent: existing?.dailySpent ?? 0,
          spent_day: existing?.spentDay ?? 0,
          packet_threshold: corridor.packetThreshold,
        }),
      );
    },
    async getCorridor(fromCountry, toCountry) {
      const result = await client
        .from("gate_corridors")
        .select("*")
        .eq("from_country", fromCountry)
        .eq("to_country", toCountry)
        .maybeSingle();
      const row = must(result);
      if (!row) return undefined;
      return {
        fromCountry: row.from_country,
        toCountry: row.to_country,
        enabled: num(row.enabled),
        perPaymentCap: num(row.per_payment_cap),
        dailyCap: num(row.daily_cap),
        dailySpent: num(row.daily_spent),
        spentDay: num(row.spent_day),
        packetThreshold: num(row.packet_threshold),
      };
    },
    async commitFund(payment, day) {
      const fresh = await this.getMandate(payment.mandateId);
      const seen = await this.getPayment(payment.paymentId);
      if (
        !fresh ||
        seen ||
        fresh.spent + payment.amount > fresh.budget ||
        fresh.uses >= fresh.maxUses
      ) {
        throw new Error("BUDGET");
      }
      must(
        await client
          .from("gate_mandates")
          .update({ spent: fresh.spent + payment.amount, uses: fresh.uses + 1 })
          .eq("mandate_id", payment.mandateId),
      );
      const corridor = await this.getCorridor(payment.fromCountry, payment.toCountry);
      if (corridor) {
        const spent = corridor.spentDay === day ? corridor.dailySpent + payment.amount : payment.amount;
        must(
          await client
            .from("gate_corridors")
            .update({ daily_spent: spent, spent_day: day })
            .eq("from_country", payment.fromCountry)
            .eq("to_country", payment.toCountry),
        );
      }
      must(
        await client.from("gate_payments").insert({
          payment_id: payment.paymentId,
          mandate_id: payment.mandateId,
          mandate: payment.mandate,
          buyer: payment.buyer,
          agent: payment.agent,
          vendor: payment.vendor,
          mint: payment.mint,
          amount: payment.amount,
          from_country: payment.fromCountry,
          to_country: payment.toCountry,
          category: payment.category,
          purpose_code: payment.purposeCode,
          invoice_hash: payment.invoiceHash,
          invoice_amount: payment.invoiceAmount,
          packet_hash: payment.packetHash,
          state: payment.state,
          receipt_hash: payment.receiptHash,
          verification_hash: payment.verificationHash,
          delivery_deadline: payment.deliveryDeadline,
          acceptance_deadline: payment.acceptanceDeadline,
        }),
      );
    },
    async getPayment(paymentId) {
      const result = await client
        .from("gate_payments")
        .select("*")
        .eq("payment_id", paymentId)
        .maybeSingle();
      const row = must(result);
      if (!row) return undefined;
      return {
        paymentId: row.payment_id,
        mandateId: num(row.mandate_id),
        mandate: row.mandate,
        buyer: row.buyer,
        agent: row.agent,
        vendor: row.vendor,
        mint: row.mint,
        amount: num(row.amount),
        fromCountry: row.from_country,
        toCountry: row.to_country,
        category: num(row.category),
        purposeCode: num(row.purpose_code),
        invoiceHash: row.invoice_hash,
        invoiceAmount: num(row.invoice_amount),
        packetHash: row.packet_hash,
        state: row.state,
        receiptHash: row.receipt_hash,
        verificationHash: row.verification_hash,
        deliveryDeadline: num(row.delivery_deadline),
        acceptanceDeadline: num(row.acceptance_deadline),
      };
    },
    async updatePayment(paymentId, patch) {
      const current = await this.getPayment(paymentId);
      if (!current) return;
      must(
        await client
          .from("gate_payments")
          .update({
            state: patch.state ?? current.state,
            receipt_hash:
              patch.receiptHash === undefined ? current.receiptHash : patch.receiptHash,
            verification_hash:
              patch.verificationHash === undefined
                ? current.verificationHash
                : patch.verificationHash,
            acceptance_deadline: patch.acceptanceDeadline ?? current.acceptanceDeadline,
          })
          .eq("payment_id", paymentId),
      );
    },
    async insertEvidence(evidence) {
      const result = await client
        .from("gate_evidence")
        .insert({
          created_at: evidence.createdAt,
          kind: evidence.kind,
          decision: evidence.decision,
          payment_id: evidence.paymentId,
          mandate: evidence.mandate,
          buyer: evidence.buyer,
          vendor: evidence.vendor,
          amount: evidence.amount,
          reasons: evidence.reasons,
          checks_run: evidence.checksRun,
          checks_failed: evidence.checksFailed,
          clearance_hash: evidence.clearanceHash,
          forced: evidence.forced,
        })
        .select("id")
        .single();
      return num(must(result).id);
    },
    async listEvidence(paymentId) {
      const result = await client
        .from("gate_evidence")
        .select("*")
        .eq("payment_id", paymentId)
        .order("id");
      return must(result).map((row) => ({
        id: num(row.id),
        createdAt: num(row.created_at),
        kind: row.kind,
        decision: row.decision,
        paymentId: row.payment_id,
        mandate: row.mandate,
        buyer: row.buyer,
        vendor: row.vendor,
        amount: num(row.amount),
        reasons: row.reasons as string[],
        checksRun: num(row.checks_run),
        checksFailed: num(row.checks_failed),
        clearanceHash: row.clearance_hash,
        forced: Boolean(row.forced),
      }));
    },
    async listProviderChecks() {
      return [];
    },
  };
}
