import { DatabaseSync } from "node:sqlite";

export type CorridorRef = { fromCountry: string; toCountry: string };

export type MandateRow = {
  mandateId: number;
  mandate: string;
  owner: string;
  agent: string;
  budget: number;
  spent: number;
  perPaymentLimit: number;
  maxUses: number;
  uses: number;
  expiresAt: number;
  deliverySeconds: number;
  acceptanceSeconds: number;
  category: number;
  revoked: number;
  corridors: CorridorRef[];
};

export type VendorRow = {
  wallet: string;
  name: string;
  country: string;
  blocked: number;
};

export type CorridorRow = {
  fromCountry: string;
  toCountry: string;
  enabled: number;
  perPaymentCap: number;
  dailyCap: number;
  dailySpent: number;
  spentDay: number;
  packetThreshold: number;
};

export type PaymentRow = {
  paymentId: string;
  mandateId: number;
  mandate: string;
  buyer: string;
  agent: string;
  vendor: string;
  mint: string;
  amount: number;
  fromCountry: string;
  toCountry: string;
  category: number;
  purposeCode: number;
  invoiceHash: string;
  invoiceAmount: number;
  packetHash: string;
  state: string;
  receiptHash: string | null;
  verificationHash: string | null;
  deliveryDeadline: number;
  acceptanceDeadline: number;
};

export type EvidenceInput = {
  createdAt: number;
  kind: string;
  decision: string;
  paymentId: string;
  mandate: string;
  buyer: string;
  vendor: string;
  amount: number;
  reasons: string[];
  checksRun: number;
  checksFailed: number;
  clearanceHash: string;
  forced: boolean;
};

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendors (
      wallet TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      country TEXT NOT NULL,
      blocked INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mandates (
      mandate_id INTEGER PRIMARY KEY,
      mandate TEXT NOT NULL,
      owner TEXT NOT NULL,
      agent TEXT NOT NULL,
      budget INTEGER NOT NULL,
      spent INTEGER NOT NULL,
      per_payment_limit INTEGER NOT NULL,
      max_uses INTEGER NOT NULL,
      uses INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      delivery_seconds INTEGER NOT NULL,
      acceptance_seconds INTEGER NOT NULL,
      category INTEGER NOT NULL,
      revoked INTEGER NOT NULL,
      corridors TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS corridors (
      from_country TEXT NOT NULL,
      to_country TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      per_payment_cap INTEGER NOT NULL,
      daily_cap INTEGER NOT NULL,
      daily_spent INTEGER NOT NULL,
      spent_day INTEGER NOT NULL,
      packet_threshold INTEGER NOT NULL,
      PRIMARY KEY (from_country, to_country)
    );
    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      mandate_id INTEGER NOT NULL,
      mandate TEXT NOT NULL,
      buyer TEXT NOT NULL,
      agent TEXT NOT NULL,
      vendor TEXT NOT NULL,
      mint TEXT NOT NULL,
      amount INTEGER NOT NULL,
      from_country TEXT NOT NULL,
      to_country TEXT NOT NULL,
      category INTEGER NOT NULL,
      purpose_code INTEGER NOT NULL,
      invoice_hash TEXT NOT NULL,
      invoice_amount INTEGER NOT NULL,
      packet_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      receipt_hash TEXT,
      verification_hash TEXT,
      delivery_deadline INTEGER NOT NULL,
      acceptance_deadline INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_verifications (
      vendor_wallet TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      expires_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      verified INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payment_id TEXT,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_checks (
      id TEXT PRIMARY KEY,
      payment_id TEXT,
      wallet TEXT NOT NULL,
      check_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      environment TEXT NOT NULL,
      public_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      decision TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      mandate TEXT NOT NULL,
      buyer TEXT NOT NULL,
      vendor TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reasons TEXT NOT NULL,
      checks_run INTEGER NOT NULL,
      checks_failed INTEGER NOT NULL,
      clearance_hash TEXT NOT NULL,
      forced INTEGER NOT NULL
    );
  `);
  try {
    db.exec(
      "ALTER TABLE provider_checks ADD COLUMN public_note TEXT NOT NULL DEFAULT ''"
    );
  } catch {
    // The column is already present on databases created with this schema.
  }
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type IdentityRow = {
  vendorWallet: string;
  provider: string;
  sessionId: string;
  status: string;
  expiresAt: string | null;
  updatedAt: string;
};

export function getIdentity(
  db: DatabaseSync,
  vendorWallet: string
): IdentityRow | undefined {
  const row = db
    .prepare(
      `SELECT vendor_wallet, provider, session_id, status, expires_at, updated_at
       FROM identity_verifications WHERE vendor_wallet = ?`
    )
    .get(vendorWallet) as
    | {
        vendor_wallet: string;
        provider: string;
        session_id: string;
        status: string;
        expires_at: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    vendorWallet: row.vendor_wallet,
    provider: row.provider,
    sessionId: row.session_id,
    status: row.status,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export function upsertIdentity(db: DatabaseSync, row: IdentityRow): void {
  db.prepare(
    `INSERT INTO identity_verifications
      (vendor_wallet, provider, session_id, status, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(vendor_wallet) DO UPDATE SET
      provider = excluded.provider,
      session_id = excluded.session_id,
      status = excluded.status,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at`
  ).run(
    row.vendorWallet,
    row.provider,
    row.sessionId,
    row.status,
    row.expiresAt,
    row.updatedAt
  );
}

export function insertWebhookEvent(
  db: DatabaseSync,
  row: { id: string; provider: string; sessionId: string; receivedAt: string }
): boolean {
  const existing = db
    .prepare("SELECT id FROM webhook_events WHERE id = ?")
    .get(row.id);
  if (existing) return false;
  db.prepare(
    `INSERT INTO webhook_events (id, provider, session_id, received_at, verified)
     VALUES (?, ?, ?, ?, 1)`
  ).run(row.id, row.provider, row.sessionId, row.receivedAt);
  return true;
}

export function insertLocalAudit(
  db: DatabaseSync,
  row: {
    id: string;
    actorType: string;
    actorId: string;
    action: string;
    paymentId: string | null;
    details: Record<string, unknown>;
    createdAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO audit_log
      (id, actor_type, actor_id, action, payment_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.actorType,
    row.actorId,
    row.action,
    row.paymentId,
    JSON.stringify(row.details),
    row.createdAt
  );
}

export function listProviderChecks(
  db: DatabaseSync,
  paymentId: string
): Array<{
  checkId: string;
  status: string;
  reasonCode: string;
  evidenceHash: string;
  provider: string;
  environment: string;
  publicNote: string;
}> {
  const rows = db
    .prepare(
      `SELECT check_id, status, reason_code, evidence_hash, provider, environment, public_note
       FROM provider_checks WHERE payment_id = ? ORDER BY created_at`
    )
    .all(paymentId) as Array<{
    check_id: string;
    status: string;
    reason_code: string;
    evidence_hash: string;
    provider: string;
    environment: string;
    public_note: string;
  }>;
  return rows.map((row) => ({
    checkId: row.check_id,
    status: row.status,
    reasonCode: row.reason_code,
    evidenceHash: row.evidence_hash,
    provider: row.provider,
    environment: row.environment,
    publicNote: row.public_note,
  }));
}

export function insertProviderCheck(
  db: DatabaseSync,
  row: {
    id: string;
    paymentId: string | null;
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
): void {
  db.prepare(
    `INSERT INTO provider_checks
      (id, payment_id, wallet, check_id, status, reason_code, evidence_hash, provider, environment, public_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.paymentId,
    row.wallet,
    row.checkId,
    row.status,
    row.reasonCode,
    row.evidenceHash,
    row.provider,
    row.environment,
    row.publicNote ?? "",
    row.createdAt
  );
}

export function insertVendor(
  db: DatabaseSync,
  vendor: { wallet: string; name: string; country: string; blocked: boolean }
) {
  db.prepare(
    `INSERT INTO vendors (wallet, name, country, blocked)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET name = excluded.name, country = excluded.country, blocked = excluded.blocked`
  ).run(vendor.wallet, vendor.name, vendor.country, vendor.blocked ? 1 : 0);
}

export function getVendor(
  db: DatabaseSync,
  wallet: string
): VendorRow | undefined {
  return db
    .prepare(
      "SELECT wallet, name, country, blocked FROM vendors WHERE wallet = ?"
    )
    .get(wallet) as VendorRow | undefined;
}

export function insertMandate(
  db: DatabaseSync,
  mandate: Omit<MandateRow, "spent" | "uses" | "revoked">
) {
  db.prepare(
    `INSERT INTO mandates (
      mandate_id, mandate, owner, agent, budget, spent, per_payment_limit, max_uses, uses,
      expires_at, delivery_seconds, acceptance_seconds, category, revoked, corridors
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, 0, ?)`
  ).run(
    mandate.mandateId,
    mandate.mandate,
    mandate.owner,
    mandate.agent,
    mandate.budget,
    mandate.perPaymentLimit,
    mandate.maxUses,
    mandate.expiresAt,
    mandate.deliverySeconds,
    mandate.acceptanceSeconds,
    mandate.category,
    JSON.stringify(mandate.corridors)
  );
}

export function getMandate(
  db: DatabaseSync,
  mandateId: number
): MandateRow | undefined {
  const row = db
    .prepare(
      `SELECT mandate_id AS mandateId, mandate, owner, agent, budget, spent,
              per_payment_limit AS perPaymentLimit, max_uses AS maxUses, uses, expires_at AS expiresAt,
              delivery_seconds AS deliverySeconds, acceptance_seconds AS acceptanceSeconds,
              category, revoked, corridors
       FROM mandates WHERE mandate_id = ?`
    )
    .get(mandateId) as
    (Omit<MandateRow, "corridors"> & { corridors: string }) | undefined;
  if (!row) return undefined;
  return { ...row, corridors: JSON.parse(row.corridors) as CorridorRef[] };
}

export function revokeMandate(db: DatabaseSync, mandateId: number) {
  db.prepare("UPDATE mandates SET revoked = 1 WHERE mandate_id = ?").run(
    mandateId
  );
}

export function commitSpend(
  db: DatabaseSync,
  mandateId: number,
  amount: number
) {
  db.prepare(
    "UPDATE mandates SET spent = spent + ?, uses = uses + 1 WHERE mandate_id = ?"
  ).run(amount, mandateId);
}

export function upsertCorridor(
  db: DatabaseSync,
  corridor: Omit<CorridorRow, "dailySpent" | "spentDay">
) {
  const existing = getCorridor(db, corridor.fromCountry, corridor.toCountry);
  db.prepare(
    `INSERT INTO corridors (
      from_country, to_country, enabled, per_payment_cap, daily_cap, daily_spent, spent_day, packet_threshold
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(from_country, to_country) DO UPDATE SET
      enabled = excluded.enabled,
      per_payment_cap = excluded.per_payment_cap,
      daily_cap = excluded.daily_cap,
      packet_threshold = excluded.packet_threshold`
  ).run(
    corridor.fromCountry,
    corridor.toCountry,
    corridor.enabled ? 1 : 0,
    corridor.perPaymentCap,
    corridor.dailyCap,
    existing?.dailySpent ?? 0,
    existing?.spentDay ?? 0,
    corridor.packetThreshold
  );
}

export function getCorridor(
  db: DatabaseSync,
  fromCountry: string,
  toCountry: string
): CorridorRow | undefined {
  return db
    .prepare(
      `SELECT from_country AS fromCountry, to_country AS toCountry, enabled,
              per_payment_cap AS perPaymentCap, daily_cap AS dailyCap, daily_spent AS dailySpent,
              spent_day AS spentDay, packet_threshold AS packetThreshold
       FROM corridors WHERE from_country = ? AND to_country = ?`
    )
    .get(fromCountry, toCountry) as CorridorRow | undefined;
}

export function commitCorridorSpend(
  db: DatabaseSync,
  fromCountry: string,
  toCountry: string,
  amount: number,
  day: number
) {
  const corridor = getCorridor(db, fromCountry, toCountry);
  if (!corridor) return;
  const spent =
    corridor.spentDay === day ? corridor.dailySpent + amount : amount;
  db.prepare(
    "UPDATE corridors SET daily_spent = ?, spent_day = ? WHERE from_country = ? AND to_country = ?"
  ).run(spent, day, fromCountry, toCountry);
}

export function getPayment(
  db: DatabaseSync,
  paymentId: string
): PaymentRow | undefined {
  return db
    .prepare(
      `SELECT payment_id AS paymentId, mandate_id AS mandateId, mandate, buyer, agent, vendor, mint,
              amount, from_country AS fromCountry, to_country AS toCountry, category,
              purpose_code AS purposeCode, invoice_hash AS invoiceHash, invoice_amount AS invoiceAmount,
              packet_hash AS packetHash, state, receipt_hash AS receiptHash,
              verification_hash AS verificationHash, delivery_deadline AS deliveryDeadline,
              acceptance_deadline AS acceptanceDeadline
       FROM payments WHERE payment_id = ?`
    )
    .get(paymentId) as PaymentRow | undefined;
}

export function insertPayment(db: DatabaseSync, payment: PaymentRow) {
  db.prepare(
    `INSERT INTO payments (
      payment_id, mandate_id, mandate, buyer, agent, vendor, mint, amount, from_country, to_country,
      category, purpose_code, invoice_hash, invoice_amount, packet_hash, state, receipt_hash,
      verification_hash, delivery_deadline, acceptance_deadline
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    payment.paymentId,
    payment.mandateId,
    payment.mandate,
    payment.buyer,
    payment.agent,
    payment.vendor,
    payment.mint,
    payment.amount,
    payment.fromCountry,
    payment.toCountry,
    payment.category,
    payment.purposeCode,
    payment.invoiceHash,
    payment.invoiceAmount,
    payment.packetHash,
    payment.state,
    payment.receiptHash,
    payment.verificationHash,
    payment.deliveryDeadline,
    payment.acceptanceDeadline
  );
}

export function updatePayment(
  db: DatabaseSync,
  paymentId: string,
  patch: Partial<
    Pick<
      PaymentRow,
      "state" | "receiptHash" | "verificationHash" | "acceptanceDeadline"
    >
  >
) {
  const current = getPayment(db, paymentId);
  if (!current) return;
  db.prepare(
    `UPDATE payments
     SET state = ?, receipt_hash = ?, verification_hash = ?, acceptance_deadline = ?
     WHERE payment_id = ?`
  ).run(
    patch.state ?? current.state,
    patch.receiptHash === undefined ? current.receiptHash : patch.receiptHash,
    patch.verificationHash === undefined
      ? current.verificationHash
      : patch.verificationHash,
    patch.acceptanceDeadline ?? current.acceptanceDeadline,
    paymentId
  );
}

export function insertEvidence(
  db: DatabaseSync,
  evidence: EvidenceInput
): number {
  const result = db
    .prepare(
      `INSERT INTO evidence (
        created_at, kind, decision, payment_id, mandate, buyer, vendor, amount, reasons,
        checks_run, checks_failed, clearance_hash, forced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      evidence.createdAt,
      evidence.kind,
      evidence.decision,
      evidence.paymentId,
      evidence.mandate,
      evidence.buyer,
      evidence.vendor,
      evidence.amount,
      JSON.stringify(evidence.reasons),
      evidence.checksRun,
      evidence.checksFailed,
      evidence.clearanceHash,
      evidence.forced ? 1 : 0
    );
  return Number(result.lastInsertRowid);
}

export function listEvidence(db: DatabaseSync, paymentId: string) {
  return (
    db
      .prepare(
        `SELECT id, created_at AS createdAt, kind, decision, payment_id AS paymentId, mandate, buyer,
                vendor, amount, reasons, checks_run AS checksRun, checks_failed AS checksFailed,
                clearance_hash AS clearanceHash, forced
         FROM evidence WHERE payment_id = ? ORDER BY id`
      )
      .all(paymentId) as Array<Record<string, unknown>>
  ).map((row) => ({
    ...row,
    reasons: JSON.parse(String(row.reasons)) as string[],
    forced: row.forced === 1,
  }));
}
