import type { DatabaseSync } from "node:sqlite";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getIdentity,
  upsertIdentity,
  insertProviderCheck,
  insertWebhookEvent,
  insertLocalAudit,
  listProviderChecks,
  type IdentityRow,
} from "../db.ts";

type Check = Parameters<typeof insertProviderCheck>[1];
type Event = Parameters<typeof insertWebhookEvent>[1];
type Audit = Parameters<typeof insertLocalAudit>[1];
export interface ProviderStore {
  getIdentity(wallet: string): Promise<IdentityRow | undefined>;
  saveIdentity(row: IdentityRow): Promise<void>;
  insertCheck(row: Check): Promise<void>;
  listChecks(paymentId: string): Promise<ReturnType<typeof listProviderChecks>>;
  insertEvent(row: Event): Promise<boolean>;
  insertAudit(row: Audit): Promise<void>;
}
export function sqliteProviderStore(db: DatabaseSync): ProviderStore {
  return {
    async getIdentity(wallet) {
      return getIdentity(db, wallet);
    },
    async saveIdentity(row) {
      upsertIdentity(db, row);
    },
    async insertCheck(row) {
      insertProviderCheck(db, row);
    },
    async listChecks(paymentId) {
      return listProviderChecks(db, paymentId);
    },
    async insertEvent(row) {
      return insertWebhookEvent(db, row);
    },
    async insertAudit(row) {
      insertLocalAudit(db, row);
    },
  };
}
export function supabaseProviderStore(client: SupabaseClient): ProviderStore {
  function checked(result: { error: unknown }) {
    if (result.error) throw new Error("PROVIDER_STORAGE_UNAVAILABLE");
  }
  return {
    async getIdentity(wallet) {
      const result = await client
        .from("identity_verifications")
        .select("*")
        .eq("vendor_wallet", wallet)
        .maybeSingle();
      checked(result);
      const row = result.data;
      return row
        ? {
            vendorWallet: row.vendor_wallet,
            provider: row.provider,
            sessionId: row.session_id,
            status: row.status,
            expiresAt: row.expires_at,
            updatedAt: row.updated_at,
          }
        : undefined;
    },
    async saveIdentity(row) {
      checked(
        await client
          .from("identity_verifications")
          .upsert({
            vendor_wallet: row.vendorWallet,
            provider: row.provider,
            session_id: row.sessionId,
            status: row.status,
            expires_at: row.expiresAt,
            updated_at: row.updatedAt,
          })
      );
    },
    async insertCheck(row) {
      checked(
        await client
          .from("gate_provider_checks")
          .insert({
            id: row.id,
            payment_id: row.paymentId,
            wallet: row.wallet,
            check_id: row.checkId,
            status: row.status,
            reason_code: row.reasonCode,
            evidence_hash: row.evidenceHash,
            provider: row.provider,
            environment: row.environment,
            public_note: row.publicNote ?? "",
            created_at: row.createdAt,
          })
      );
    },
    async listChecks(paymentId) {
      const result = await client
        .from("gate_provider_checks")
        .select(
          "check_id,status,reason_code,evidence_hash,provider,environment,public_note"
        )
        .eq("payment_id", paymentId)
        .order("created_at");
      checked(result);
      return (result.data ?? []).map((row) => ({
        checkId: row.check_id,
        status: row.status,
        reasonCode: row.reason_code,
        evidenceHash: row.evidence_hash,
        provider: row.provider,
        environment: row.environment,
        publicNote: row.public_note,
      }));
    },
    async insertEvent(row) {
      const result = await client
        .from("webhook_events")
        .insert({
          id: row.id,
          provider: row.provider,
          session_id: row.sessionId,
          received_at: row.receivedAt,
          verified: true,
        });
      if (result.error?.code === "23505") return false;
      checked(result);
      return true;
    },
    async insertAudit(row) {
      checked(
        await client
          .from("audit_log")
          .insert({
            id: row.id,
            actor_type: row.actorType,
            actor_id: row.actorId,
            action: row.action,
            payment_id: row.paymentId,
            details: row.details,
            created_at: row.createdAt,
          })
      );
    },
  };
}
