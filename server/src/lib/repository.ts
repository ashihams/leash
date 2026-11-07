import { randomUUID } from "node:crypto";
import type { HistoryStatus } from "./outcomes.ts";

export type Role = "owner" | "reviewer" | "auditor";

export type Actor =
  | { type: "anon" }
  | { type: "user"; userId: string }
  | { type: "service" }
  | { type: "database_owner" };

export class RlsError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export type Profile = {
  id: string;
  email: string;
  role: Role;
  displayName: string;
  createdAt: string;
};

export type NonceRow = {
  nonce: string;
  wallet: string;
  purpose: string;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
};

export type LinkedWallet = {
  id: string;
  userId: string;
  wallet: string;
  kind: "owner" | "reviewer";
  verifiedAt: string | null;
  createdAt: string;
};

export type PaymentRow = {
  paymentId: string;
  buyer: string;
  vendor: string;
  amountUsdc: string;
  status: HistoryStatus;
  createdAt: string;
};

export type ClearanceRow = {
  paymentId: string;
  decision: "allow" | "review" | "deny";
  checksRun: string;
  checksFailed: string;
  policyVersion: string;
  listVersion: string;
  expiresAt: string;
  signature: string;
  createdAt: string;
};

export type CheckRow = {
  id: string;
  paymentId: string;
  checkId: string;
  status: "pass" | "flag" | "fail";
  reasonCode: string;
  evidenceHash: string;
  provider?: string;
  environment?: string;
  createdAt: string;
};

export type ReviewRow = {
  paymentId: string;
  flagged: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "timed_out";
  reviewerUserId: string | null;
  reviewerWallet: string | null;
  reviewerSignature: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type AuditRow = {
  id: string;
  actorType: "user" | "wallet" | "system";
  actorId: string;
  action: string;
  paymentId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

export type HistoryRepository = {
  insertNonce(row: NonceRow): Promise<void>;
  findNonce(nonce: string): Promise<NonceRow | null>;
  consumeNonce(nonce: string, wallet: string, nowSeconds: number): Promise<boolean>;
  insertAudit(row: Omit<AuditRow, "id"> & { id?: string }): Promise<void>;
  getProfile(userId: string): Promise<Profile | null>;
  linkWallet(row: LinkedWallet): Promise<void>;
  findLinked(userId: string, wallet: string): Promise<LinkedWallet | null>;
  upsertPayment(row: PaymentRow): Promise<void>;
  listPayments(): Promise<PaymentRow[]>;
  getPayment(paymentId: string): Promise<PaymentRow | null>;
  upsertClearance(row: ClearanceRow): Promise<void>;
  getClearance(paymentId: string): Promise<ClearanceRow | null>;
  insertCheck(row: CheckRow): Promise<void>;
  listChecks(paymentId: string): Promise<CheckRow[]>;
  insertReview(row: ReviewRow): Promise<void>;
  listReviews(): Promise<ReviewRow[]>;
  getReview(paymentId: string): Promise<ReviewRow | null>;
  decideReview(
    paymentId: string,
    decision: {
      status: "approved" | "denied" | "timed_out";
      reviewerUserId: string | null;
      reviewerWallet: string | null;
      reviewerSignature: string | null;
      decidedAt: string;
    },
  ): Promise<"ok" | "missing" | "decided">;
  listAudit(paymentId: string): Promise<AuditRow[]>;
  listVendorPayments(
    wallet: string,
  ): Promise<Array<{ status: HistoryStatus; createdAt: string }>>;
  isScreened(wallet: string): Promise<boolean>;
};

const STAFF_TABLES = [
  "payment_history",
  "clearances",
  "check_results",
  "audit_log",
] as const;

export class MemoryDb implements HistoryRepository {
  profiles: Profile[] = [];
  nonces: NonceRow[] = [];
  wallets: LinkedWallet[] = [];
  payments: PaymentRow[] = [];
  clearances: ClearanceRow[] = [];
  checks: CheckRow[] = [];
  reviews: ReviewRow[] = [];
  audits: AuditRow[] = [];
  vendors: Array<Record<string, unknown>> = [];
  screening: Array<{ wallet: string }> = [];

  async insertNonce(row: NonceRow): Promise<void> {
    this.nonces.push({ ...row });
  }

  async findNonce(nonce: string): Promise<NonceRow | null> {
    return this.nonces.find((row) => row.nonce === nonce) ?? null;
  }

  async consumeNonce(
    nonce: string,
    wallet: string,
    nowSeconds: number,
  ): Promise<boolean> {
    const row = this.nonces.find(
      (item) =>
        item.nonce === nonce &&
        item.wallet === wallet &&
        !item.used &&
        item.expiresAt > nowSeconds,
    );
    if (!row) return false;
    row.used = true;
    return true;
  }

  async insertAudit(row: Omit<AuditRow, "id"> & { id?: string }): Promise<void> {
    this.audits.push({ ...row, id: row.id ?? randomUUID() });
  }

  async getProfile(userId: string): Promise<Profile | null> {
    return this.profiles.find((row) => row.id === userId) ?? null;
  }

  async linkWallet(row: LinkedWallet): Promise<void> {
    const existing = this.wallets.find((item) => item.wallet === row.wallet);
    if (existing) throw new Error("WALLET_TAKEN");
    this.wallets.push({ ...row });
  }

  async findLinked(userId: string, wallet: string): Promise<LinkedWallet | null> {
    return (
      this.wallets.find(
        (row) => row.userId === userId && row.wallet === wallet,
      ) ?? null
    );
  }

  async upsertPayment(row: PaymentRow): Promise<void> {
    const index = this.payments.findIndex(
      (item) => item.paymentId === row.paymentId,
    );
    if (index === -1) this.payments.push({ ...row });
    else this.payments[index] = { ...this.payments[index], ...row, createdAt: this.payments[index].createdAt };
  }

  async listPayments(): Promise<PaymentRow[]> {
    return [...this.payments].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  async getPayment(paymentId: string): Promise<PaymentRow | null> {
    return this.payments.find((row) => row.paymentId === paymentId) ?? null;
  }

  async upsertClearance(row: ClearanceRow): Promise<void> {
    const index = this.clearances.findIndex(
      (item) => item.paymentId === row.paymentId,
    );
    if (index === -1) this.clearances.push({ ...row });
    else this.clearances[index] = { ...row };
  }

  async getClearance(paymentId: string): Promise<ClearanceRow | null> {
    return this.clearances.find((row) => row.paymentId === paymentId) ?? null;
  }

  async insertCheck(row: CheckRow): Promise<void> {
    this.checks.push({ ...row });
  }

  async listChecks(paymentId: string): Promise<CheckRow[]> {
    return this.checks.filter((row) => row.paymentId === paymentId);
  }

  async insertReview(row: ReviewRow): Promise<void> {
    this.reviews.push({ ...row });
  }

  async listReviews(): Promise<ReviewRow[]> {
    return [...this.reviews].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  async getReview(paymentId: string): Promise<ReviewRow | null> {
    return this.reviews.find((row) => row.paymentId === paymentId) ?? null;
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
    const row = this.reviews.find((item) => item.paymentId === paymentId);
    if (!row) return "missing";
    if (row.status !== "pending") return "decided";
    row.status = decision.status;
    row.reviewerUserId = decision.reviewerUserId;
    row.reviewerWallet = decision.reviewerWallet;
    row.reviewerSignature = decision.reviewerSignature;
    row.decidedAt = decision.decidedAt;
    return "ok";
  }

  async listAudit(paymentId: string): Promise<AuditRow[]> {
    return this.audits.filter((row) => row.paymentId === paymentId);
  }

  async listVendorPayments(wallet: string) {
    return this.payments
      .filter((row) => row.vendor === wallet)
      .map((row) => ({ status: row.status, createdAt: row.createdAt }));
  }

  async isScreened(wallet: string): Promise<boolean> {
    return this.screening.some((row) => row.wallet === wallet);
  }

  client(actor: Actor): RlsClient {
    return new RlsClient(this, actor);
  }
}

type TableName =
  | "profiles"
  | "profile_directory"
  | "linked_wallets"
  | "vendors"
  | "screening_list"
  | "payment_history"
  | "clearances"
  | "check_results"
  | "review_queue"
  | "auth_nonces"
  | "audit_log";

export class RlsClient {
  private readonly db: MemoryDb;
  private readonly actor: Actor;

  constructor(db: MemoryDb, actor: Actor) {
    this.db = db;
    this.actor = actor;
  }

  from(table: TableName): RlsQuery {
    return new RlsQuery(this.db, this.actor, table);
  }
}

class RlsQuery {
  private operation: "select" | "insert" | "update" | "delete" = "select";
  private values: Record<string, unknown> | null = null;
  private filters: Array<[string, unknown]> = [];

  private readonly db: MemoryDb;
  private readonly actor: Actor;
  private readonly table: TableName;

  constructor(db: MemoryDb, actor: Actor, table: TableName) {
    this.db = db;
    this.actor = actor;
    this.table = table;
  }

  select(): this {
    this.operation = "select";
    return this;
  }

  insert(values: Record<string, unknown>): this {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.operation = "update";
    this.values = values;
    return this;
  }

  delete(): this {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  async exec(): Promise<unknown> {
    if (this.operation === "select") return this.read();
    if (this.operation === "insert") return this.writeInsert();
    if (this.operation === "update") return this.writeUpdate();
    return this.writeDelete();
  }

  private read(): unknown[] {
    const scope = selectScope(this.db, this.actor, this.table);
    const rows = rowsFor(this.db, this.table).filter((row) =>
      this.filters.every(([column, value]) => row[column] === value),
    );
    if (scope === "own") {
      return rows.filter((row) => row.id === userId(this.actor));
    }
    if (scope === "own-wallet") {
      return rows.filter((row) => row.userId === userId(this.actor));
    }
    if (scope === "directory") {
      return rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        role: row.role,
      }));
    }
    return rows.map((row) => ({ ...row }));
  }

  private writeInsert(): Record<string, unknown> {
    assertWrite(this.actor, this.table, "insert");
    const row = { ...(this.values ?? {}) };
    rowsFor(this.db, this.table).push(row);
    return row;
  }

  private writeUpdate(): unknown[] {
    assertWrite(this.actor, this.table, "update");
    const rows = rowsFor(this.db, this.table).filter((row) =>
      this.filters.every(([column, value]) => row[column] === value),
    );
    const patch = this.values ?? {};
    if (this.table === "profiles" && this.actor.type === "user") {
      for (const row of rows) {
        if (row.id !== this.actor.userId) throw new RlsError("RLS_DENIED");
        if ("role" in patch && patch.role !== row.role) {
          throw new RlsError("ROLE_IMMUTABLE");
        }
        const keys = Object.keys(patch).filter((key) => key !== "role");
        if (keys.some((key) => key !== "displayName")) {
          throw new RlsError("RLS_DENIED");
        }
        if (typeof patch.displayName === "string") {
          row.displayName = patch.displayName;
        }
      }
      return rows;
    }
    for (const row of rows) Object.assign(row, patch);
    return rows;
  }

  private writeDelete(): { count: number } {
    assertWrite(this.actor, this.table, "delete");
    const all = rowsFor(this.db, this.table);
    const kept = all.filter(
      (row) => !this.filters.every(([column, value]) => row[column] === value),
    );
    const count = all.length - kept.length;
    replaceRows(this.db, this.table, kept);
    return { count };
  }
}

function userId(actor: Actor): string {
  if (actor.type !== "user") throw new RlsError("RLS_DENIED");
  return actor.userId;
}

function selectScope(
  db: MemoryDb,
  actor: Actor,
  table: TableName,
): "all" | "own" | "own-wallet" | "directory" {
  if (actor.type === "anon") throw new RlsError("RLS_DENIED");
  if (actor.type === "service" || actor.type === "database_owner") return "all";
  const profile = db.profiles.find((row) => row.id === actor.userId);
  if (!profile) throw new RlsError("RLS_DENIED");
  if (table === "profiles") return "own";
  if (table === "profile_directory") {
    if (profile.role === "auditor" || profile.role === "reviewer") {
      return "directory";
    }
    throw new RlsError("RLS_DENIED");
  }
  if (table === "linked_wallets") return "own-wallet";
  if (table === "auth_nonces") throw new RlsError("RLS_DENIED");
  if (table === "review_queue") {
    if (profile.role !== "reviewer") throw new RlsError("RLS_DENIED");
    return "all";
  }
  if (table === "vendors" || table === "screening_list") return "all";
  if (
    STAFF_TABLES.includes(table as (typeof STAFF_TABLES)[number]) &&
    (profile.role === "owner" ||
      profile.role === "reviewer" ||
      profile.role === "auditor")
  ) {
    return "all";
  }
  throw new RlsError("RLS_DENIED");
}

function assertWrite(
  actor: Actor,
  table: TableName,
  operation: "insert" | "update" | "delete",
): void {
  if (table === "audit_log" && operation !== "insert") {
    if (actor.type !== "database_owner") {
      throw new RlsError("AUDIT_APPEND_ONLY");
    }
    return;
  }
  if (actor.type === "anon" || actor.type === "user") {
    if (
      actor.type === "user" &&
      table === "profiles" &&
      operation === "update"
    ) {
      return;
    }
    throw new RlsError("RLS_DENIED");
  }
}

function rowsFor(
  db: MemoryDb,
  table: TableName,
): Array<Record<string, unknown>> {
  switch (table) {
    case "profiles":
    case "profile_directory":
      return db.profiles as unknown as Array<Record<string, unknown>>;
    case "linked_wallets":
      return db.wallets as unknown as Array<Record<string, unknown>>;
    case "vendors":
      return db.vendors;
    case "screening_list":
      return db.screening as unknown as Array<Record<string, unknown>>;
    case "payment_history":
      return db.payments as unknown as Array<Record<string, unknown>>;
    case "clearances":
      return db.clearances as unknown as Array<Record<string, unknown>>;
    case "check_results":
      return db.checks as unknown as Array<Record<string, unknown>>;
    case "review_queue":
      return db.reviews as unknown as Array<Record<string, unknown>>;
    case "auth_nonces":
      return db.nonces as unknown as Array<Record<string, unknown>>;
    case "audit_log":
      return db.audits as unknown as Array<Record<string, unknown>>;
  }
}

function replaceRows(
  db: MemoryDb,
  table: TableName,
  rows: Array<Record<string, unknown>>,
): void {
  const target = rowsFor(db, table);
  target.splice(0, target.length, ...rows);
}
