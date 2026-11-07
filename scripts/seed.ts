import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import "dotenv/config";
import {
  buildDemoHistory,
  expectedGateOutcome,
  vendorStats,
} from "../server/src/lib/outcomes.ts";

const DEMO_USERS = [
  { email: "owner@leash.local", role: "owner", name: "Demo Owner" },
  { email: "reviewer@leash.local", role: "reviewer", name: "Demo Reviewer" },
  { email: "auditor@leash.local", role: "auditor", name: "Demo Auditor" },
] as const;

type SavedKey = { publicKey: string; secretKey: string };

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
if (!url || !serviceKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env before seeding.");
  process.exit(1);
}

mkdirSync("keys", { recursive: true });
const keyPath = "keys/demo.json";
const saved = existsSync(keyPath)
  ? (JSON.parse(readFileSync(keyPath, "utf8")) as {
      buyer: SavedKey;
      reviewer?: SavedKey;
      vendors: Record<string, SavedKey>;
    })
  : null;

const nowMs = Date.now();
const plans = buildDemoHistory(nowMs);
const buyer = saved?.buyer ?? saveKey(nacl.sign.keyPair());
const reviewerKey = saved?.reviewer ?? saveKey(nacl.sign.keyPair());
const vendorKeys: Record<string, SavedKey> = {};
for (const plan of plans) {
  vendorKeys[plan.key] =
    saved?.vendors[plan.key] ?? saveKey(nacl.sign.keyPair());
}
if (!saved || !saved.reviewer) {
  writeFileSync(
    keyPath,
    JSON.stringify({ buyer, reviewer: reviewerKey, vendors: vendorKeys }, null, 2),
  );
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const wiped = await supabase.rpc("wipe_demo_history");
if (wiped.error) {
  console.error("Could not wipe demo history. Apply the Supabase migration first.");
  process.exit(1);
}

const password = process.env.SEED_DEMO_PASSWORD ?? "leash-demo-mock";
const listed = await supabase.auth.admin.listUsers({ perPage: 200 });
if (listed.error) {
  console.error("Could not list auth users.");
  process.exit(1);
}
for (const demo of DEMO_USERS) {
  const existing = listed.data.users.find((user) => user.email === demo.email);
  if (existing) {
    const removed = await supabase.auth.admin.deleteUser(existing.id);
    if (removed.error) {
      console.error(`Could not reset ${demo.email}.`);
      process.exit(1);
    }
  }
  const created = await supabase.auth.admin.createUser({
    email: demo.email,
    password,
    email_confirm: true,
    user_metadata: { display_name: demo.name },
  });
  if (created.error || !created.data.user) {
    console.error(`Could not create ${demo.email}.`);
    process.exit(1);
  }
  if (demo.role !== "auditor") {
    const updated = await supabase
      .from("profiles")
      .update({ role: demo.role, display_name: demo.name })
      .eq("id", created.data.user.id);
    if (updated.error) {
      console.error(`Could not set the ${demo.role} role.`);
      process.exit(1);
    }
  }
}

const vendors = plans.map((plan) => ({
  wallet: vendorKeys[plan.key].publicKey,
  name: plan.name,
  country: plan.country,
  category: 7,
  status: "active",
  credential_expires_at: null,
  credential_is_mock: false,
}));
const vendorInsert = await supabase.from("vendors").insert(vendors);
if (vendorInsert.error) {
  console.error("Could not seed vendors.");
  process.exit(1);
}

const payments = plans.flatMap((plan) =>
  plan.payments.map((row) => ({
    payment_id: randomBytes(32).toString("hex"),
    buyer: buyer.publicKey,
    vendor: vendorKeys[plan.key].publicKey,
    amount_usdc: 100_000_000,
    status: row.status,
    created_at: row.createdAt,
  })),
);
const paymentInsert = await supabase.from("payment_history").insert(payments);
if (paymentInsert.error) {
  console.error("Could not seed payment history.");
  process.exit(1);
}

console.log("Demo users: owner@leash.local, reviewer@leash.local, auditor@leash.local");
console.log("Their password is SEED_DEMO_PASSWORD in .env.");
for (const plan of plans) {
  const outcome = expectedGateOutcome(
    vendorStats(plan.payments, false, nowMs),
  );
  console.log(`${plan.name}  ${vendorKeys[plan.key].publicKey}  ${outcome}`);
}
console.log(
  "No screening rows or credentials were seeded. Solana sanctions coverage is not assumed.",
);
console.log(`Buyer ${buyer.publicKey}`);
console.log(`Reviewer wallet ${reviewerKey.publicKey}`);

function saveKey(key: nacl.SignKeyPair): SavedKey {
  return {
    publicKey: bs58.encode(key.publicKey),
    secretKey: Buffer.from(key.secretKey).toString("base64"),
  };
}
