import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import {
  address,
  createSolanaRpc,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { readChainSnapshot } from "../server/src/chain-readiness.ts";
import {
  DEVNET_RPC,
  PROGRAM_ID,
  PROGRAM_LOADER,
} from "../src/leash/deployment.ts";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { createMandateInstruction } from "../src/leash/chain.ts";
import { mandatePda } from "../src/leash/pda.ts";

const chain = await readChainSnapshot();
const program = address(PROGRAM_ID);
const loader = address(PROGRAM_LOADER);
const rpc = createSolanaRpc(DEVNET_RPC);
const [programData] = await getProgramDerivedAddress({
  programAddress: loader,
  seeds: [getAddressEncoder().encode(program)],
});
const { value: deployed } = await rpc
  .getAccountInfo(programData, { encoding: "base64", commitment: "confirmed" })
  .send({ abortSignal: AbortSignal.timeout(8000) });
let binaryMatches = null;
if (existsSync("anchor/target/deploy/leash.so") && deployed?.owner === loader) {
  const elf = readFileSync("anchor/target/deploy/leash.so");
  binaryMatches = Buffer.from(deployed.data[0], "base64")
    .subarray(45, 45 + elf.length)
    .equals(elf);
}
const gateUrl = process.env.LEASH_GATE_URL ?? "http://127.0.0.1:8787";
let gate = { url: gateUrl, reachable: false, matches: false };
try {
  const response = await fetch(`${gateUrl.replace(/\/$/, "")}/health`, {
    signal: AbortSignal.timeout(8000),
  });
  const health = await response.json();
  const mismatches = [
    "mint",
    "policySigner",
    "verifier",
    "policyVersion",
  ].filter((key) => health[key] !== chain.config?.[key]);
  gate = {
    url: gateUrl,
    reachable: response.ok,
    matches: response.ok && mismatches.length === 0,
    mismatches,
  };
} catch (error) {
  gate.error = error.message;
}
const status = {
  ...chain,
  binaryMatches,
  environmentMintMatches: Boolean(
    chain.config && process.env.LEASH_USDC_MINT === chain.config.mint
  ),
  gate,
};
// Explicit opt-in to an unsigned simulation; this script never signs or sends.
if (process.argv.includes("--simulate") && chain.config) {
  const owner = address(chain.config.admin);
  const mandateId = Date.now();
  const instruction = await createMandateInstruction({
    owner,
    mandate: await mandatePda(owner, mandateId),
    mandateId,
    agent: chain.config.policySigner,
    mint: chain.config.mint,
    budget: 2_000_000,
    perPayment: 1_000_000,
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  });
  const { value: latest } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(owner), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions([instruction], m)
  );
  const { value } = await rpc
    .simulateTransaction(
      getBase64EncodedWireTransaction(compileTransaction(message)),
      {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
      }
    )
    .send({ abortSignal: AbortSignal.timeout(8000) });
  status.mandateSimulation = {
    passed: value.err === null,
    error: value.err,
    logs: value.logs,
  };
  if (value.err) process.exitCode = 1;
}
console.log(JSON.stringify(status, null, 2));
if (
  !chain.programDeployed ||
  !chain.config ||
  binaryMatches === false ||
  !status.environmentMintMatches ||
  !gate.matches ||
  chain.routes.some((route) => route.status !== "ready")
)
  process.exitCode = 1;
