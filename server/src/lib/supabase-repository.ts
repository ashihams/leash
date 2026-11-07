import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AuditRow,
  CheckRow,
  ClearanceRow,
  HistoryRepository,
  LinkedWallet,
  NonceRow,
  PaymentRow,
  Profile,
  ReviewRow,
} from "./repository.ts";
import type { HistoryStatus } from "./outcomes.ts";

export function createServiceClient(url: string, serviceKey: string) {
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export class SupabaseRepository implements HistoryRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async insertNonce(row: NonceRow): Promise<void> {
    const { error } = await this.supabase.from("auth_nonces").insert({
      nonce: row.nonce,
      wallet: row.wallet,
      purpose: row.purpose,
      issued_at: iso(row.issuedAt),
      expires_at: iso(row.expiresAt),
      used: false,
    });
    fail(error);
  }

  async findNonce(nonce: string): Promise<NonceRow | null> {
    const { data, error } = await this.supabase
      .from("auth_nonces")
      .select("nonce, wallet, purpose, issued_at, expires_at, used")
      .eq("nonce", nonce)
      .maybeSingle();
    fail(error);
    if (!data) return null;
    return {
      nonce: data.nonce,
      wallet: data.wallet,
      purpose: data.purpose,
      issuedAt: seconds(data.issued_at),
      expiresAt: seconds(data.expires_at),
      used: data.used,
    };
  }

  async consumeNonce(
    nonce: string,
    wallet: string,
    nowSeconds: number,
  ): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("auth_nonces")
      .update({ used: true })
      .eq("nonce", nonce)
      .eq("wallet", wallet)
      .eq("used", false)
      .gt("expires_at", iso(nowSeconds))
      .select("nonce");
    fail(error);
    return Array.isArray(data) && data.length > 0;
  }

  async insertAudit(row: Omit<AuditRow, "id"> & { id?: string }): Promise<void> {
    const { error } = await this.supabase.from("audit_log").insert({
      actor_type: row.actorType,
      actor_id: row.actorId,
      action: row.action,
      payment_id: row.paymentId,
      details: row.details,
    });
    fail(error);
  }

  async getProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await this.supabase
      .from("profiles")
      .select("id, email, role, display_name, created_at")
      .eq("id", userId)
      .maybeSingle();
    fail(error);
    if (!data) return null;
    return {
      id: data.id,
      email: data.email ?? "",
      role: data.role,
      displayName: data.display_name,
      createdAt: data.created_at,
    };
  }

  async linkWallet(row: LinkedWallet): Promise<void> {
    const { error } = await this.supabase.from("linked_wallets").insert({
      id: row.id,
      user_id: row.userId,
      wallet: row.wallet,
      kind: row.kind,
      verified_at: row.verifiedAt,
    });
    if (error) throw new Error("CHECK_UNAVAILABLE");
  }

  async findLinked(userId: string, wallet: string): Promise<LinkedWallet | null> {
    const { data, error } = await this.supabase
      .from("linked_wallets")
      .select("id, user_id, wallet, kind, verified_at, created_at")
      .eq("user_id", userId)
      .eq("wallet", wallet)
      .maybeSingle();
    fail(error);
    if (!data) return null;
    return {
      id: data.id,
      userId: data.user_id,
      wallet: data.wallet,
      kind: data.kind,
      verifiedAt: data.verified_at,
      createdAt: data.created_at,
    };
  }

  async upsertPayment(row: PaymentRow): Promise<void> {
    const { error } = await this.supabase.from("payment_history").upsert({
      payment_id: row.paymentId,
      buyer: row.buyer,
      vendor: row.vendor,
      amount_usdc: row.amountUsdc,
      status: row.status,
      created_at: row.createdAt,
    });
    fail(error);
  }

  async listPayments(): Promise<PaymentRow[]> {
    const { data, error } = await this.supabase
      .from("payment_history")
      .select("payment_id, buyer, vendor, amount_usdc, status, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    fail(error);
    return (data ?? []).map(paymentFrom);
  }

  async getPayment(paymentId: string): Promise<PaymentRow | null> {
    const { data, error } = await this.supabase
      .from("payment_history")
      .select("payment_id, buyer, vendor, amount_usdc, status, created_at")
      .eq("payment_id", paymentId)
      .maybeSingle();
    fail(error);
    return data ? paymentFrom(data) : null;
  }

  async upsertClearance(row: ClearanceRow): Promise<void> {
    const { error } = await this.supabase.from("clearances").upsert({
      payment_id: row.paymentId,
      decision: row.decision,
      checks_run: row.checksRun,
      checks_failed: row.checksFailed,
      policy_version: row.policyVersion,
      list_version: row.listVersion,
      expires_at: row.expiresAt,
      signature: row.signature,
      created_at: row.createdAt,
    });
    fail(error);
  }

  async getClearance(paymentId: string): Promise<ClearanceRow | null> {
    const { data, error } = await this.supabase
      .from("clearances")
      .select(
        "payment_id, decision, checks_run, checks_failed, policy_version, list_version, expires_at, signature, created_at",
      )
      .eq("payment_id", paymentId)
      .maybeSingle();
    fail(error);
    if (!data) return null;
    return {
      paymentId: data.payment_id,
      decision: data.decision,
      checksRun: String(data.checks_run),
      checksFailed: String(data.checks_failed),
      policyVersion: String(data.policy_version),
      listVersion: String(data.list_version),
      expiresAt: data.expires_at,
      signature: data.signature,
      createdAt: data.created_at,
    };
  }

  async insertCheck(row: CheckRow): Promise<void> {
    const { error } = await this.supabase.from("check_results").insert({
      id: row.id,
      payment_id: row.paymentId,
      check_id: row.checkId,
      status: row.status,
      reason_code: row.reasonCode,
      evidence_hash: row.evidenceHash,
    });
    fail(error);
  }

  async listChecks(paymentId: string): Promise<CheckRow[]> {
    const { data, error } = await this.supabase
      .from("check_results")
      .select("id, payment_id, check_id, status, reason_code, evidence_hash, created_at")
      .eq("payment_id", paymentId);
    fail(error);
    return (data ?? []).map((row) => ({
      id: row.id,
      paymentId: row.payment_id,
      checkId: row.check_id,
      status: row.status,
      reasonCode: row.reason_code,
      evidenceHash: row.evidence_hash,
      createdAt: row.created_at,
    }));
  }

  async insertReview(row: ReviewRow): Promise<void> {
    const { error } = await this.supabase.from("review_queue").insert({
      payment_id: row.paymentId,
      flagged: row.flagged,
      status: row.status,
      created_at: row.createdAt,
    });
    fail(error);
  }

  async listReviews(): Promise<ReviewRow[]> {
    const { data, error } = await this.supabase
      .from("review_queue")
      .select(
        "payment_id, flagged, status, reviewer_user_id, reviewer_wallet, reviewer_signature, created_at, decided_at",
      )
      .order("created_at", { ascending: false });
    fail(error);
    return (data ?? []).map(reviewFrom);
  }

  async getReview(paymentId: string): Promise<ReviewRow | null> {
    const { data, error } = await this.supabase
      .from("review_queue")
      .select(
        "payment_id, flagged, status, reviewer_user_id, reviewer_wallet, reviewer_signature, created_at, decided_at",
      )
      .eq("payment_id", paymentId)
      .maybeSingle();
    fail(error);
    return data ? reviewFrom(data) : null;
  }

  async decideReview(
    paymentId: string,
    decision: {
      status: "approved" | "denied" | "timed_out";
      reviewerUserId: string | null;
      reviewerWallet: string | null;
      reviewerSignature: string | null;
      decidedAt: string;
    },
  ): Promise<"ok" | "missing" | "decided"> {
    const existing = await this.getReview(paymentId);
    if (!existing) return "missing";
    if (existing.status !== "pending") return "decided";
    const { data, error } = await this.supabase
      .from("review_queue")
      .update({
        status: decision.status,
        reviewer_user_id: decision.reviewerUserId,
        reviewer_wallet: decision.reviewerWallet,
        reviewer_signature: decision.reviewerSignature,
        decided_at: decision.decidedAt,
      })
      .eq("payment_id", paymentId)
      .eq("status", "pending")
      .select("payment_id");
    fail(error);
    return data && data.length > 0 ? "ok" : "decided";
  }

  async listAudit(paymentId: string): Promise<AuditRow[]> {
    const { data, error } = await this.supabase
      .from("audit_log")
      .select("id, actor_type, actor_id, action, payment_id, details, created_at")
      .eq("payment_id", paymentId);
    fail(error);
    return (data ?? []).map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      paymentId: row.payment_id,
      details: row.details ?? {},
      createdAt: row.created_at,
    }));
  }

  async listVendorPayments(wallet: string) {
    const { data, error } = await this.supabase
      .from("payment_history")
      .select("status, created_at")
      .eq("vendor", wallet);
    fail(error);
    return (data ?? []).map((row) => ({
      status: row.status as HistoryStatus,
      createdAt: row.created_at as string,
    }));
  }

  async isScreened(wallet: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("screening_list")
      .select("wallet")
      .eq("wallet", wallet)
      .maybeSingle();
    fail(error);
    return Boolean(data);
  }
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error("CHECK_UNAVAILABLE");
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function seconds(value: string): number {
  return Math.floor(Date.parse(value) / 1000);
}

function paymentFrom(row: {
  payment_id: string;
  buyer: string;
  vendor: string;
  amount_usdc: string | number;
  status: HistoryStatus;
  created_at: string;
}): PaymentRow {
  return {
    paymentId: row.payment_id,
    buyer: row.buyer,
    vendor: row.vendor,
    amountUsdc: String(row.amount_usdc),
    status: row.status,
    createdAt: row.created_at,
  };
}

function reviewFrom(row: {
  payment_id: string;
  flagged: Record<string, unknown> | null;
  status: ReviewRow["status"];
  reviewer_user_id: string | null;
  reviewer_wallet: string | null;
  reviewer_signature: string | null;
  created_at: string;
  decided_at: string | null;
}): ReviewRow {
  return {
    paymentId: row.payment_id,
    flagged: row.flagged ?? {},
    status: row.status,
    reviewerUserId: row.reviewer_user_id,
    reviewerWallet: row.reviewer_wallet,
    reviewerSignature: row.reviewer_signature,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}
