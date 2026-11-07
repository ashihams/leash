import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildHistoryApp } from "../server/src/history-app.ts";
import { challengeMessage, reviewMessage } from "../server/src/lib/messages.ts";
import { buildDemoHistory } from "../server/src/lib/outcomes.ts";
import { MemoryDb, RlsError } from "../server/src/lib/repository.ts";
import { walletKeyPair } from "../server/src/lib/wallet-token.ts";

const encoder = new TextEncoder();
const secret = walletKeyPair(new Uint8Array(32).fill(7));

function address(publicKey: Uint8Array) {
  return bs58.encode(publicKey);
}

function sign(message: string, key: Uint8Array) {
  return bs58.encode(nacl.sign.detached(encoder.encode(message), key));
}

function payment(id: string) {
  return id.padStart(64, "a");
}

async function post(
  app: Awaited<ReturnType<typeof buildHistoryApp>>,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });
  return { status: response.statusCode, body: response.json() };
}

describe("wallet challenges", () => {
  it("rejects a reused, expired, or wrong-wallet nonce and a modified message", async () => {
    const db = new MemoryDb();
    let clock = 1_700_000_000;
    const app = await buildHistoryApp({
      db,
      getDashboardUser: async () => null,
      internalSecret: "internal-test-secret",
      tokenSecretKey: secret.secretKey,
      tokenPublicKey: secret.publicKey,
      now: () => clock,
    });
    const first = nacl.sign.keyPair();
    const second = nacl.sign.keyPair();
    const wallet = address(first.publicKey);
    const other = address(second.publicKey);

    const issued = await post(app, "/auth/challenge", {
      wallet,
      purpose: "link_wallet",
    });
    expect(issued.status).toBe(200);
    const signature = sign(issued.body.message, first.secretKey);
    const mismatch = await post(app, "/auth/verify", {
      wallet: other,
      nonce: issued.body.nonce,
      signature: sign(issued.body.message, second.secretKey),
    });
    expect(mismatch.status).toBe(401);
    expect(mismatch.body.error).toBe("WALLET_MISMATCH");

    const ok = await post(app, "/auth/verify", {
      wallet,
      nonce: issued.body.nonce,
      signature,
    });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe("string");

    const again = await post(app, "/auth/verify", {
      wallet,
      nonce: issued.body.nonce,
      signature,
    });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("NONCE_USED");

    const expiredIssue = await post(app, "/auth/challenge", {
      wallet,
      purpose: "buyer_auth",
    });
    clock += 120;
    const expired = await post(app, "/auth/verify", {
      wallet,
      nonce: expiredIssue.body.nonce,
      signature: sign(expiredIssue.body.message, first.secretKey),
    });
    expect(expired.status).toBe(401);
    expect(expired.body.error).toBe("NONCE_EXPIRED");

    clock = 1_700_000_000;
    const fresh = await post(app, "/auth/challenge", {
      wallet,
      purpose: "intent",
    });
    const tampered = challengeMessage({
      wallet,
      purpose: "intent",
      nonce: fresh.body.nonce,
      issuedAt: fresh.body.issuedAt,
      expiresAt: fresh.body.expiresAt,
    }).replace("Leash", "Lease");
    const bad = await post(app, "/auth/verify", {
      wallet,
      nonce: fresh.body.nonce,
      signature: sign(tampered, first.secretKey),
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe("SIGNATURE_INVALID");
    await app.close();
  });
});

describe("reviews", () => {
  it("lets a linked reviewer decide once and refuses an auditor or a second decision", async () => {
    const db = new MemoryDb();
    const clock = 1_700_000_000;
    const reviewerId = "reviewer-user";
    const auditorId = "auditor-user";
    db.profiles.push(
      {
        id: reviewerId,
        email: "reviewer@leash.local",
        role: "reviewer",
        displayName: "Reviewer",
        createdAt: new Date(clock * 1000).toISOString(),
      },
      {
        id: auditorId,
        email: "auditor@leash.local",
        role: "auditor",
        displayName: "Auditor",
        createdAt: new Date(clock * 1000).toISOString(),
      },
    );
    const reviewerKey = nacl.sign.keyPair();
    const wallet = address(reviewerKey.publicKey);
    db.wallets.push({
      id: "link-1",
      userId: reviewerId,
      wallet,
      kind: "reviewer",
      verifiedAt: new Date(clock * 1000).toISOString(),
      createdAt: new Date(clock * 1000).toISOString(),
    });
    const id = payment("1");
    db.reviews.push({
      paymentId: id,
      flagged: { reason: "MOCK" },
      status: "pending",
      reviewerUserId: null,
      reviewerWallet: null,
      reviewerSignature: null,
      createdAt: new Date(clock * 1000).toISOString(),
      decidedAt: null,
    });
    const app = await buildHistoryApp({
      db,
      getDashboardUser: async (token) => {
        if (token === "reviewer") return { id: reviewerId, email: "reviewer@leash.local" };
        if (token === "auditor") return { id: auditorId, email: "auditor@leash.local" };
        return null;
      },
      internalSecret: "internal-test-secret",
      tokenSecretKey: secret.secretKey,
      tokenPublicKey: secret.publicKey,
      now: () => clock,
    });

    const blocked = await post(
      app,
      `/reviews/${id}/decision`,
      { status: "approved", wallet, nonce: "x".repeat(32), signature: "y".repeat(64) },
      { authorization: "Bearer auditor" },
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("FORBIDDEN");
    expect(db.reviews[0].status).toBe("pending");

    const nonce = await post(app, "/auth/challenge", { wallet, purpose: "review" });
    const message = reviewMessage({
      wallet,
      paymentId: id,
      decision: "approved",
      nonce: nonce.body.nonce,
    });
    const decided = await post(
      app,
      `/reviews/${id}/decision`,
      {
        status: "approved",
        wallet,
        nonce: nonce.body.nonce,
        signature: sign(message, reviewerKey.secretKey),
      },
      { authorization: "Bearer reviewer" },
    );
    expect(decided.status).toBe(200);
    expect(decided.body.status).toBe("approved");

    const secondNonce = await post(app, "/auth/challenge", {
      wallet,
      purpose: "review",
    });
    const repeat = await post(
      app,
      `/reviews/${id}/decision`,
      {
        status: "denied",
        wallet,
        nonce: secondNonce.body.nonce,
        signature: sign(
          reviewMessage({
            wallet,
            paymentId: id,
            decision: "denied",
            nonce: secondNonce.body.nonce,
          }),
          reviewerKey.secretKey,
        ),
      },
      { authorization: "Bearer reviewer" },
    );
    expect(repeat.status).toBe(409);
    expect(repeat.body.error).toBe("ALREADY_DECIDED");
    expect(db.reviews[0].status).toBe("approved");
    await app.close();
  });

  it("treats a missed timeout as timed_out and will not decide it later", async () => {
    const db = new MemoryDb();
    const clock = 1_700_000_000;
    db.profiles.push({
      id: "reviewer-user",
      email: "reviewer@leash.local",
      role: "reviewer",
      displayName: "Reviewer",
      createdAt: new Date(clock * 1000).toISOString(),
    });
    const id = payment("2");
    db.reviews.push({
      paymentId: id,
      flagged: {},
      status: "pending",
      reviewerUserId: null,
      reviewerWallet: null,
      reviewerSignature: null,
      createdAt: new Date((clock - 120) * 1000).toISOString(),
      decidedAt: null,
    });
    const app = await buildHistoryApp({
      db,
      getDashboardUser: async () => ({
        id: "reviewer-user",
        email: "reviewer@leash.local",
      }),
      internalSecret: "internal-test-secret",
      tokenSecretKey: secret.secretKey,
      tokenPublicKey: secret.publicKey,
      now: () => clock,
      reviewTimeoutSeconds: 60,
    });
    const response = await post(
      app,
      `/reviews/${id}/decision`,
      {},
      { authorization: "Bearer reviewer" },
    );
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("TIMED_OUT");
    expect(db.reviews[0].status).toBe("timed_out");
    const again = await post(
      app,
      `/reviews/${id}/decision`,
      {},
      { authorization: "Bearer reviewer" },
    );
    expect(again.status).toBe(409);
    expect(db.reviews[0].status).toBe("timed_out");
    await app.close();
  });
});

describe("row security", () => {
  it("stops a user from changing their own role", async () => {
    const db = new MemoryDb();
    db.profiles.push({
      id: "user-1",
      email: "owner@leash.local",
      role: "auditor",
      displayName: "Ada",
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    const user = db.client({ type: "user", userId: "user-1" });
    await expect(
      user.from("profiles").update({ role: "owner" }).eq("id", "user-1").exec(),
    ).rejects.toBeInstanceOf(RlsError);
    expect(db.profiles[0].role).toBe("auditor");
    await user
      .from("profiles")
      .update({ displayName: "Ada Lovelace" })
      .eq("id", "user-1")
      .exec();
    expect(db.profiles[0].displayName).toBe("Ada Lovelace");
  });

  it("denies anon reads and client writes on evidence tables", async () => {
    const db = new MemoryDb();
    db.profiles.push({
      id: "user-1",
      email: "auditor@leash.local",
      role: "auditor",
      displayName: "Aud",
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    db.payments.push({
      paymentId: payment("3"),
      buyer: "buyer",
      vendor: "vendor",
      amountUsdc: "1",
      status: "funded",
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    db.audits.push({
      id: "audit-1",
      actorType: "system",
      actorId: "gate",
      action: "test",
      paymentId: null,
      details: {},
      createdAt: "2026-11-07T00:00:00.000Z",
    });
    const anon = db.client({ type: "anon" });
    const user = db.client({ type: "user", userId: "user-1" });
    const tables = [
      "profiles",
      "linked_wallets",
      "vendors",
      "screening_list",
      "payment_history",
      "clearances",
      "check_results",
      "review_queue",
      "auth_nonces",
      "audit_log",
    ] as const;
    for (const table of tables) {
      await expect(anon.from(table).select().exec()).rejects.toMatchObject({
        code: "RLS_DENIED",
      });
    }
    await expect(
      user.from("payment_history").insert({ paymentId: payment("4") }).exec(),
    ).rejects.toMatchObject({ code: "RLS_DENIED" });
    await expect(
      user
        .from("payment_history")
        .update({ status: "released" })
        .eq("paymentId", payment("3"))
        .exec(),
    ).rejects.toMatchObject({ code: "RLS_DENIED" });
    await expect(
      user.from("clearances").insert({ paymentId: payment("4") }).exec(),
    ).rejects.toMatchObject({ code: "RLS_DENIED" });
    await expect(
      user.from("clearances").update({ decision: "allow" }).exec(),
    ).rejects.toMatchObject({ code: "RLS_DENIED" });
    await expect(
      user.from("audit_log").insert({ action: "tamper" }).exec(),
    ).rejects.toMatchObject({ code: "RLS_DENIED" });
    await expect(
      user.from("audit_log").update({ action: "tamper" }).eq("id", "audit-1").exec(),
    ).rejects.toMatchObject({ code: "AUDIT_APPEND_ONLY" });
    await expect(
      db
        .client({ type: "service" })
        .from("audit_log")
        .update({ action: "tamper" })
        .eq("id", "audit-1")
        .exec(),
    ).rejects.toMatchObject({ code: "AUDIT_APPEND_ONLY" });
    await expect(
      db
        .client({ type: "service" })
        .from("audit_log")
        .delete()
        .eq("id", "audit-1")
        .exec(),
    ).rejects.toMatchObject({ code: "AUDIT_APPEND_ONLY" });
    await db
      .client({ type: "database_owner" })
      .from("audit_log")
      .update({ action: "maintained" })
      .eq("id", "audit-1")
      .exec();
    expect(db.audits[0].action).toBe("maintained");
    expect(db.payments[0].status).toBe("funded");
  });
});

describe("history rules", () => {
  it("labels the five demo vendors with the expected gate outcome", () => {
    const demo = buildDemoHistory(Date.parse("2026-11-07T08:00:00.000Z"));
    expect(demo.map((vendor) => [vendor.name, vendor.outcome])).toEqual([
      ["Acme Design", "ALLOW"],
      ["BrightHost", "ALLOW"],
      ["Fast Lane", "DENY CHECK_VELOCITY"],
      ["Returnly", "DENY CHECK_REFUND_RATIO"],
      ["Shadow Vendor", "DENY CHECK_SCREENING"],
    ]);
  });

  it("keeps the migration fail-closed", () => {
    const sql = readFileSync(
      "supabase/migrations/20261107143000_leash_history.sql",
      "utf8",
    );
    for (const table of [
      "profiles",
      "linked_wallets",
      "vendors",
      "screening_list",
      "payment_history",
      "clearances",
      "check_results",
      "review_queue",
      "auth_nonces",
      "audit_log",
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain("role cannot be changed by the user");
    expect(sql).toContain("'auditor'");
    expect(sql).not.toContain("new.raw_user_meta_data->>'role'");
    expect(sql).toContain("audit_log is append-only");
    expect(sql).not.toMatch(/on public\.payment_history\s+for insert/i);
    expect(sql).not.toMatch(/on public\.clearances\s+for insert/i);
    expect(sql).not.toMatch(/on public\.audit_log\s+for update/i);
    expect(sql).toContain("revoke all on public.payment_history from public, anon, authenticated");
  });
});
