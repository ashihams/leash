import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { encodeBase58 } from "./bytes.ts";
import { buildApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { persistClearance } from "./lib/persist-clearance.ts";
import {
  createServiceClient,
  SupabaseRepository,
} from "./lib/supabase-repository.ts";
import { walletKeyPair } from "./lib/wallet-token.ts";
import { registerHistoryRoutes } from "./routes/history.ts";

const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
mkdirSync(dataDir, { recursive: true });

const mint = process.env.LEASH_USDC_MINT;
if (!mint) {
  console.error("Set LEASH_USDC_MINT to the test USDC mint address.");
  process.exit(1);
}
const policyVersion = Number(process.env.LEASH_POLICY_VERSION ?? "1");
if (!Number.isSafeInteger(policyVersion) || policyVersion <= 0) {
  console.error("LEASH_POLICY_VERSION must be a positive integer.");
  process.exit(1);
}

const policy = loadKey("policy");
const verifier = loadKey("verifier");
const db = openDatabase(
  fileURLToPath(new URL("../data/leash.sqlite", import.meta.url))
);
const history = historyBackend();
const app = buildApp({
  db,
  policy,
  verifier: verifier.publicKey,
  mint,
  policyVersion,
  persistHistory: history
    ? persistClearance(history.db, policyVersion)
    : undefined,
});
if (history) {
  registerHistoryRoutes(app, history.deps);
  console.log("History backend is on. Solana remains the source of truth.");
}
const port = Number(process.env.PORT ?? "8787");

app.listen({ port, host: "127.0.0.1" }).then(() => {
  console.log(`Leash gate listening on http://127.0.0.1:${port}`);
  console.log(`policy signer ${encodeBase58(policy.publicKey)}`);
  console.log(`verifier ${encodeBase58(verifier.publicKey)}`);
});

function historyBackend() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const seed = process.env.WALLET_AUTH_SECRET;
  if (!url || !serviceKey || !internalSecret || !seed) {
    if (url || serviceKey || internalSecret || seed) {
      console.error(
        "History backend is off. Set SUPABASE_URL, SUPABASE_SERVICE_KEY, INTERNAL_API_SECRET, and WALLET_AUTH_SECRET together."
      );
    }
    return null;
  }
  const seedBytes = Buffer.from(seed, "base64");
  if (seedBytes.length !== 32) {
    console.error(
      "History backend is off. WALLET_AUTH_SECRET must be 32 bytes of base64."
    );
    return null;
  }
  const keys = walletKeyPair(seedBytes);
  const supabase = createServiceClient(url, serviceKey);
  const repository = new SupabaseRepository(supabase);
  return {
    db: repository,
    deps: {
      db: repository,
      internalSecret,
      tokenSecretKey: keys.secretKey,
      tokenPublicKey: keys.publicKey,
      getDashboardUser: async (token: string) => {
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data.user) return null;
        return { id: data.user.id, email: data.user.email ?? "" };
      },
    },
  };
}

function loadKey(name: string) {
  const path = fileURLToPath(new URL(`../data/${name}.json`, import.meta.url));
  if (!existsSync(path)) {
    const created = nacl.sign.keyPair();
    writeFileSync(
      path,
      JSON.stringify({
        secretKey: Buffer.from(created.secretKey).toString("base64"),
      })
    );
    return created;
  }
  const saved = JSON.parse(readFileSync(path, "utf8")) as { secretKey: string };
  return nacl.sign.keyPair.fromSecretKey(
    Uint8Array.from(Buffer.from(saved.secretKey, "base64"))
  );
}
