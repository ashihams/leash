import { readFileSync, writeFileSync, existsSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { encodeBase58 } from "./bytes.ts";
import { mintToInstruction, sendLocal, verifyInstruction } from "../../src/leash/chain.ts";

function secretFromEnvOrFile(envName: string, file: string) {
  const fromEnv = process.env[envName];
  if (fromEnv) return Uint8Array.from(Buffer.from(fromEnv, "base64"));
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { secretKey?: string };
    if (!parsed.secretKey) throw new Error("CHAIN_NOT_READY");
    return Uint8Array.from(Buffer.from(parsed.secretKey, "base64"));
  } catch {
    throw new Error("CHAIN_NOT_READY");
  }
}

function addressOf(secret: Uint8Array) {
  return encodeBase58(nacl.sign.keyPair.fromSecretKey(secret).publicKey);
}

function hexToBytes(value: string) {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length !== 64) {
    throw new Error("BAD_PAYMENT_ID");
  }
  const out = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function deployPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startProgramDeploy() {
  const statusFile = fileURLToPath(new URL("../data/deploy-status.json", import.meta.url));
  if (existsSync(statusFile)) {
    const status = JSON.parse(readFileSync(statusFile, "utf8")) as { pid?: number };
    if (status.pid && deployPidAlive(status.pid)) return "running";
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const log = openSync(fileURLToPath(new URL("../data/deploy.log", import.meta.url)), "a");
  const child = spawn(process.execPath, ["scripts/devnet-bootstrap.mjs"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.unref();
  writeFileSync(statusFile, JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
  return "started";
}

export async function mintTestUsdc(owner: string) {
  const mint = process.env.LEASH_USDC_MINT;
  if (!mint) throw new Error("CHAIN_NOT_READY");
  const secret = secretFromEnvOrFile("LEASH_MINT_AUTHORITY", "server/data/mint-authority.json");
  const sent = await sendLocal(
    secret,
    await mintToInstruction({
      authority: addressOf(secret),
      mint,
      owner,
      amount: 2_000_000,
    }),
  );
  return sent.signature;
}

export async function submitVerify(paymentId: string, artifact: Uint8Array) {
  const secret = secretFromEnvOrFile("LEASH_VERIFIER_SECRET", "server/data/verifier.json");
  const sent = await sendLocal(secret, [
    await verifyInstruction({
      verifier: addressOf(secret),
      paymentId: hexToBytes(paymentId),
      artifact,
    }),
  ]);
  return sent.signature;
}
