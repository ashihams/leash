import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { encodeBase58 } from "./bytes.ts";
import { buildApp } from "./app.ts";
import { openDatabase } from "./db.ts";

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
const app = buildApp({
  db,
  policy,
  verifier: verifier.publicKey,
  mint,
  policyVersion,
});
const port = Number(process.env.PORT ?? "8787");

app.listen({ port, host: "127.0.0.1" }).then(() => {
  console.log(`Leash gate listening on http://127.0.0.1:${port}`);
  console.log(`policy signer ${encodeBase58(policy.publicKey)}`);
  console.log(`verifier ${encodeBase58(verifier.publicKey)}`);
});

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
