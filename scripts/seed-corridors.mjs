import "dotenv/config";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  address,
  AccountRole,
  createSolanaRpc,
  createNoopSigner,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  getProgramDerivedAddress,
  getAddressEncoder,
  pipe,
} from "@solana/kit";
import { CROSS_BORDER_ROUTES, countrySeed } from "../src/leash/corridors.ts";
import { DEVNET_RPC, PROGRAM_ID } from "../src/leash/deployment.ts";

const rpc = createSolanaRpc(DEVNET_RPC);
const program = address(PROGRAM_ID);
const admin = address("8ZBVLivQLgxqUpxV9z8nLWJZwpvZsXqgMmXJkAUavwrU");
const send = process.argv.includes("--send");
if (
  (await rpc.getGenesisHash().send()) !==
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw new Error("RPC is not devnet");
const [config] = await getProgramDerivedAddress({
  programAddress: program,
  seeds: [new TextEncoder().encode("config")],
});
const info = (
  await rpc
    .getAccountInfo(config, { encoding: "base64", commitment: "confirmed" })
    .send()
).value;
const bytes = info ? Buffer.from(info.data[0], "base64") : Buffer.alloc(0);
const configDisc = createHash("sha256")
  .update("account:Config")
  .digest()
  .subarray(0, 8);
if (
  info?.owner !== program ||
  bytes.length !== 149 ||
  !bytes.subarray(0, 8).equals(configDisc) ||
  !bytes.subarray(8, 40).equals(Buffer.from(getAddressEncoder().encode(admin)))
)
  throw new Error("Invalid Leash configuration or admin");
const rent = await rpc.getMinimumBalanceForRentExemption(54n).send();
const payerBalance = (await rpc.getBalance(admin).send()).value;
const u64 = (value) => {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(BigInt(value));
  return data;
};
const disc = createHash("sha256")
  .update("global:init_corridor")
  .digest()
  .subarray(0, 8);
let signer = createNoopSigner(admin);
if (send) {
  const saved = JSON.parse(
    readFileSync("server/data/devnet-payer.json", "utf8")
  );
  signer = await createKeyPairSignerFromBytes(
    Uint8Array.from(Buffer.from(saved.secretKey, "base64"))
  );
  if (signer.address !== admin)
    throw new Error("Deployer does not match the program admin");
}
const results = [];
for (const route of CROSS_BORDER_ROUTES) {
  const [corridor] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [
      new TextEncoder().encode("corridor"),
      countrySeed(route.fromCountry),
      countrySeed(route.toCountry),
    ],
  });
  const existing = (
    await rpc
      .getAccountInfo(corridor, { encoding: "base64", commitment: "confirmed" })
      .send()
  ).value;
  if (existing) {
    const data = Buffer.from(existing.data[0], "base64");
    const expected = createHash("sha256")
      .update("account:Corridor")
      .digest()
      .subarray(0, 8);
    if (
      existing.owner !== program ||
      data.length !== 54 ||
      !data.subarray(0, 8).equals(expected) ||
      data.subarray(8, 12).toString() !==
        `${route.fromCountry}${route.toCountry}` ||
      data[12] !== 1
    )
      throw new Error(`Invalid or disabled corridor ${route.id}`);
    results.push({ route: route.id, corridor, status: "already initialized" });
    continue;
  }
  const ix = {
    programAddress: program,
    accounts: [
      { address: admin, role: AccountRole.WRITABLE_SIGNER },
      { address: config, role: AccountRole.READONLY },
      { address: corridor, role: AccountRole.WRITABLE },
      {
        address: address("11111111111111111111111111111111"),
        role: AccountRole.READONLY,
      },
    ],
    data: Buffer.concat([
      disc,
      countrySeed(route.fromCountry),
      countrySeed(route.toCountry),
      Buffer.from([1]),
      u64(1_000_000),
      u64(10_000_000_000),
      u64(0),
    ]),
  };
  const { value: latest } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions([ix], m)
  );
  const unsigned = compileTransaction(message);
  const simulation = (
    await rpc
      .simulateTransaction(getBase64EncodedWireTransaction(unsigned), {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
      })
      .send()
  ).value;
  if (simulation.err)
    throw new Error(
      `Simulation failed for ${route.id}: ${JSON.stringify(simulation.err)} ${(simulation.logs ?? []).join(" | ")}`
    );
  if (!send) {
    results.push({
      route: route.id,
      corridor,
      status: "simulation passed",
      rentLamports: rent.toString(),
      estimatedFeeLamports: "5000",
    });
    continue;
  }
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 3n,
    })
    .send();
  let confirmed = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = (await rpc.getSignatureStatuses([signature]).send())
      .value[0];
    if (status?.err)
      throw new Error(`Corridor transaction rejected: ${signature}`);
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      confirmed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!confirmed)
    throw new Error(
      `Confirmation unknown; check before retrying: ${signature}`
    );
  results.push({ route: route.id, corridor, status: "confirmed", signature });
}
console.log(
  JSON.stringify(
    {
      cluster: "devnet",
      feePayer: admin,
      payerBalanceLamports: payerBalance.toString(),
      results,
    },
    null,
    2
  )
);
