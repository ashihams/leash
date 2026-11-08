import assert from "node:assert/strict";
import test from "node:test";
import nacl from "tweetnacl";
import { buildApp } from "../src/app.ts";
import { decodeBase58, encodeBase58, encodeHex, zeros } from "../src/bytes.ts";
import {
  CHECK_CORRIDOR,
  CHECK_MANDATE,
  CLEARANCE_LEN,
  ED25519_PROGRAM,
  intentMessage,
  sha256,
} from "../src/clearance.ts";
import { openDatabase } from "../src/db.ts";

const NOW = 1_700_000_000;
const PAYMENT = 100_000_000;

test("base58 round-trips a pubkey and the zero key", () => {
  const key = nacl.sign.keyPair().publicKey;
  assert.deepEqual(decodeBase58(encodeBase58(key)), key);
  assert.equal(encodeBase58(zeros(32)), "1".repeat(32));
  assert.equal(decodeBase58("1".repeat(32)).length, 32);
});

test("allow fund signs the 288-byte clearance and release waits for verification", async () => {
  const world = await setup();
  const funded = await world.fund();
  assert.equal(funded.statusCode, 200);
  const allow = funded.json();
  assert.equal(allow.decision, "allow");
  assert.equal(allow.signer, world.signer);
  assert.equal(allow.ed25519Program, ED25519_PROGRAM);
  const message = Buffer.from(allow.message, "base64");
  const signature = Buffer.from(allow.signature, "base64");
  assert.equal(message.length, CLEARANCE_LEN);
  assert.equal(message[0], 1);
  assert.equal(message[1], 1);
  assert.equal(message[2], 1);
  assert.equal(message.readBigUInt64LE(164), BigInt(PAYMENT));
  assert.equal(message.subarray(220, 224).toString("ascii"), "USD\0");
  assert.equal(
    nacl.sign.detached.verify(message, signature, world.policy.publicKey),
    true
  );
  const instruction = Buffer.from(allow.instructionData, "base64");
  assert.equal(instruction[0], 1);
  assert.equal(instruction[1], 0);
  assert.equal(instruction.readUInt16LE(4), 0xffff);
  assert.equal(instruction.readUInt16LE(8), 0xffff);
  assert.equal(instruction.readUInt16LE(14), 0xffff);
  assert.equal(instruction.readUInt16LE(12), CLEARANCE_LEN);
  assert.deepEqual(instruction.subarray(instruction.readUInt16LE(10)), message);

  const early = await world.release();
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().signed, false);
  assert.equal(early.json().error, "NOT_VERIFIED");

  const artifact = Buffer.from("DLV1north-studio-logo");
  const delivered = await world.request("/payments/delivery", {
    paymentId: world.paymentId,
    receiptHash: encodeHex(sha256(artifact)),
  });
  assert.equal(delivered.statusCode, 200);
  const bad = await world.request("/payments/verify", {
    paymentId: world.paymentId,
    artifact: Buffer.from("DLV1not-the-receipt").toString("base64"),
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "BAD_RECEIPT");
  const verified = await world.request("/payments/verify", {
    paymentId: world.paymentId,
    artifact: artifact.toString("base64"),
  });
  assert.equal(verified.statusCode, 200);

  const released = await world.release();
  assert.equal(released.statusCode, 200);
  const release = released.json();
  assert.equal(release.decision, "allow");
  const releaseMessage = Buffer.from(release.message, "base64");
  assert.equal(releaseMessage[1], 2);
  assert.equal(
    nacl.sign.detached.verify(
      releaseMessage,
      Buffer.from(release.signature, "base64"),
      world.policy.publicKey
    ),
    true
  );

  const evidence = await world.app.inject({
    method: "GET",
    url: `/evidence/${world.paymentId}`,
  });
  assert.equal(evidence.statusCode, 200);
  assert.equal(evidence.json().evidence.length >= 3, true);
});

test("a revoked mandate, a blocked vendor, and a failed check do not consume the leash", async () => {
  const world = await setup();
  await world.request("/mandates/revoke", { mandateId: 7 });
  const revoked = await world.fund();
  assert.equal(revoked.json().decision, "deny");
  assert.equal((revoked.json().checksFailed & CHECK_MANDATE) !== 0, true);
  assert.equal(revoked.json().reasons.includes("MANDATE_REVOKED"), true);

  const blocked = await setup();
  await blocked.request("/vendors", {
    wallet: blocked.vendor,
    name: "North Studio",
    country: "US",
    blocked: true,
  });
  const screened = await blocked.fund();
  assert.equal(screened.json().decision, "deny");
  assert.equal(screened.json().reasons.includes("VENDOR_BLOCKED"), true);
  assert.equal(Buffer.from(screened.json().message, "base64")[2], 0);
  const screenedAgain = await blocked.fund({ paymentId: "22".repeat(32) });
  assert.equal(screenedAgain.json().decision, "deny");
  assert.equal(screenedAgain.json().reasons.includes("VENDOR_BLOCKED"), true);
  // Repeated blocked requests must leave the entire two-payment budget available.
  await blocked.request("/vendors", {
    wallet: blocked.vendor,
    name: "North Studio",
    country: "US",
    blocked: false,
  });
  assert.equal((await blocked.fund({ paymentId: "33".repeat(32) })).json().decision, "allow");
  assert.equal((await blocked.fund({ paymentId: "44".repeat(32) })).json().decision, "allow");

  const budget = await setup();
  const first = await budget.fund({ amount: 150_000_000 });
  assert.equal(first.json().decision, "allow");
  const second = await budget.fund({
    amount: 100_000_000,
    paymentId: "22".repeat(32),
  });
  assert.equal(second.json().decision, "deny");
  assert.equal(second.json().reasons.includes("BUDGET"), true);
});

test("a disabled corridor is refused, unless the compromised signer is forced", async () => {
  const world = await setup();
  await world.request("/corridors", {
    fromCountry: "US",
    toCountry: "US",
    enabled: false,
    perPaymentCap: 150_000_000,
    dailyCap: 1_000_000_000,
    packetThreshold: 0,
  });
  const denied = await world.fund();
  assert.equal(denied.json().decision, "deny");
  assert.equal((denied.json().checksFailed & CHECK_CORRIDOR) !== 0, true);
  assert.equal(denied.json().reasons.includes("CORRIDOR_BLOCKED"), true);

  await world.request("/corridors", {
    fromCountry: "US",
    toCountry: "US",
    enabled: true,
    perPaymentCap: 150_000_000,
    dailyCap: 1_000_000_000,
    packetThreshold: 0,
  });
  const allowed = await world.fund();
  assert.equal(allowed.json().decision, "allow");

  await world.request("/corridors", {
    fromCountry: "US",
    toCountry: "US",
    enabled: false,
    perPaymentCap: 150_000_000,
    dailyCap: 1_000_000_000,
    packetThreshold: 0,
  });
  const artifact = Buffer.from("DLV1north-studio-logo");
  await world.request("/payments/delivery", {
    paymentId: world.paymentId,
    receiptHash: encodeHex(sha256(artifact)),
  });
  await world.request("/payments/verify", {
    paymentId: world.paymentId,
    artifact: artifact.toString("base64"),
  });
  const release = await world.release();
  assert.equal(release.statusCode, 409);
  assert.equal(release.json().signed, false);
  assert.equal(release.json().error, "CORRIDOR_BLOCKED");

  const forced = await world.request("/demo/force-clearance", {
    ...world.fields(),
    kind: "release",
    decision: "allow",
  });
  assert.equal(forced.statusCode, 200);
  const body = forced.json();
  assert.equal(body.decision, "allow");
  assert.equal(body.reasons.includes("FORCED"), true);
  assert.equal(Buffer.from(body.message, "base64")[2], 1);
  const evidence = await world.app.inject({
    method: "GET",
    url: `/evidence/${world.paymentId}`,
  });
  assert.equal(
    evidence.json().evidence.some((row: { forced: boolean }) => row.forced),
    true
  );
});

test("bad intent, wrong mint, self payment, and a missing packet are denied", async () => {
  const world = await setup();
  const badIntent = await world.fund({
    intentSignature: Buffer.alloc(64).toString("base64"),
  });
  assert.equal(badIntent.json().reasons.includes("INTENT_SIG"), true);

  const wrongMint = await world.fund({
    paymentId: "33".repeat(32),
    mint: encodeBase58(nacl.sign.keyPair().publicKey),
  });
  assert.equal(wrongMint.json().reasons.includes("MINT"), true);

  const self = await world.fund({
    paymentId: "44".repeat(32),
    vendor: world.buyer,
  });
  assert.equal(self.json().reasons.includes("SELF_PAYMENT"), true);

  const packet = await setup();
  await packet.request("/corridors", {
    fromCountry: "US",
    toCountry: "US",
    enabled: true,
    perPaymentCap: 150_000_000,
    dailyCap: 1_000_000_000,
    packetThreshold: 50_000_000,
  });
  const missing = await packet.fund();
  assert.equal(missing.json().reasons.includes("PACKET_REQUIRED"), true);
  const present = await packet.fund({ packetHash: "ab".repeat(32) });
  assert.equal(present.json().decision, "allow");
});

async function setup() {
  const policy = nacl.sign.keyPair();
  const owner = nacl.sign.keyPair();
  const agent = nacl.sign.keyPair();
  const vendor = nacl.sign.keyPair();
  const mint = nacl.sign.keyPair().publicKey;
  const mandate = nacl.sign.keyPair().publicKey;
  const app = buildApp({
    allowWithoutProviders: true,
    allowDemoOverrides: true,
    db: openDatabase(":memory:"),
    policy,
    verifier: nacl.sign.keyPair().publicKey,
    mint: encodeBase58(mint),
    policyVersion: 1,
    now: () => NOW,
  });
  const buyer = encodeBase58(owner.publicKey);
  const vendorWallet = encodeBase58(vendor.publicKey);
  const mandateAccount = encodeBase58(mandate);
  const mintAccount = encodeBase58(mint);
  const paymentId = "11".repeat(32);
  await app.inject({
    method: "POST",
    url: "/vendors",
    payload: { wallet: vendorWallet, name: "North Studio", country: "US" },
  });
  await app.inject({
    method: "POST",
    url: "/corridors",
    payload: {
      fromCountry: "US",
      toCountry: "US",
      enabled: true,
      perPaymentCap: 150_000_000,
      dailyCap: 1_000_000_000,
      packetThreshold: 0,
    },
  });
  await app.inject({
    method: "POST",
    url: "/mandates",
    payload: {
      mandateId: 7,
      mandate: mandateAccount,
      owner: buyer,
      agent: encodeBase58(agent.publicKey),
      budget: 200_000_000,
      perPaymentLimit: 150_000_000,
      maxUses: 4,
      expiresAt: NOW + 86_400,
      deliverySeconds: 3600,
      acceptanceSeconds: 3600,
      category: 7,
      corridors: [{ fromCountry: "US", toCountry: "US" }],
    },
  });

  function fields(overrides: Record<string, unknown> = {}) {
    const merged = {
      paymentId,
      mandateId: 7,
      mandate: mandateAccount,
      buyer,
      vendor: vendorWallet,
      mint: mintAccount,
      amount: PAYMENT,
      fromCountry: "US",
      toCountry: "US",
      category: 7,
      purposeCode: 1001,
      invoiceHash: "aa".repeat(32),
      invoiceCurrency: "USD",
      ...overrides,
    };
    return {
      ...merged,
      invoiceAmount:
        overrides.invoiceAmount === undefined
          ? merged.amount
          : overrides.invoiceAmount,
    };
  }

  function signed(payload: Record<string, unknown>, kind: number) {
    const message = intentMessage({
      kind,
      paymentId: Buffer.from(String(payload.paymentId), "hex"),
      mandate,
      buyer: owner.publicKey,
      vendor: decodeBase58(String(payload.vendor)),
      mint: decodeBase58(String(payload.mint)),
      amount: Number(payload.amount),
      fromCountry: String(payload.fromCountry),
      toCountry: String(payload.toCountry),
      category: Number(payload.category),
      purposeCode: Number(payload.purposeCode),
      invoiceHash: Buffer.from(String(payload.invoiceHash), "hex"),
      invoiceAmount: Number(payload.invoiceAmount),
    });
    return Buffer.from(nacl.sign.detached(message, agent.secretKey)).toString(
      "base64"
    );
  }

  return {
    app,
    policy,
    signer: encodeBase58(policy.publicKey),
    buyer,
    vendor: vendorWallet,
    paymentId,
    fields,
    request(url: string, payload: Record<string, unknown>) {
      return app.inject({ method: "POST", url, payload });
    },
    fund(overrides: Record<string, unknown> = {}) {
      const payload = fields(overrides);
      return app.inject({
        method: "POST",
        url: "/clearances/fund",
        payload: {
          ...payload,
          intentSignature: overrides.intentSignature ?? signed(payload, 1),
        },
      });
    },
    release() {
      const payload = fields();
      return app.inject({
        method: "POST",
        url: "/clearances/release",
        payload: { paymentId, intentSignature: signed(payload, 2) },
      });
    },
  };
}
