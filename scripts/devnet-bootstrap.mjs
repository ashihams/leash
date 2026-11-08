import { createHash } from "node:crypto";
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import nacl from "tweetnacl";
import { CROSS_BORDER_ROUTES, countrySeed } from "../src/leash/corridors.ts";
import {
  AccountRole,
  address,
  addSignersToInstruction,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBytesEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

const RPC = "https://api.devnet.solana.com";
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSTEM = address("11111111111111111111111111111111");
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RENT = address("SysvarRent111111111111111111111111111111111");
const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
const PROGRAM_ID = "8Eq2Ug3URR5ugzDfjYk4bbkBJa8o7U6YZtPp6vLDHezd";
const transport = createDefaultRpcTransport({ url: RPC });
let requestQueue = Promise.resolve();
const rpc = createSolanaRpcFromTransport((request) => {
  const work = requestQueue.then(async () => {
    for (let attempt = 0; ; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 450));
      try {
        return await transport({
          ...request,
          signal: AbortSignal.any(
            [request.signal, AbortSignal.timeout(20_000)].filter(Boolean)
          ),
        });
      } catch (error) {
        if (error?.context?.statusCode !== 429 || attempt >= 8) throw error;
        const delay = Math.min(60_000, 5000 * 2 ** attempt);
        console.log(`RPC rate limited; retrying in ${delay / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  });
  requestQueue = work.then(
    () => undefined,
    () => undefined
  );
  return work;
});
const encoder = getAddressEncoder();

function disc(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function raw(value) {
  return Uint8Array.from(encoder.encode(address(value)));
}

function loadSecret(file, envName) {
  if (process.env[envName])
    return Uint8Array.from(Buffer.from(process.env[envName], "base64"));
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(parsed)) return Uint8Array.from(parsed);
  return Uint8Array.from(Buffer.from(parsed.secretKey, "base64"));
}

function saveSecret(file, secret) {
  writeFileSync(
    file,
    JSON.stringify({ secretKey: Buffer.from(secret).toString("base64") })
  );
}

async function signerFrom(secret) {
  return createKeyPairSignerFromBytes(secret);
}

async function wait(signature) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await rpc.getSignatureStatuses([signature]).send();
    const value = status.value[0];
    if (value?.err) throw new Error(`rejected ${JSON.stringify(value.err)}`);
    if (
      value?.confirmationStatus === "confirmed" ||
      value?.confirmationStatus === "finalized"
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`unconfirmed ${signature}`);
}

let cachedBlockhash;
let cachedBlockhashAt = 0;

async function blockhash() {
  if (!cachedBlockhash || Date.now() - cachedBlockhashAt > 25_000) {
    cachedBlockhash = (await rpc.getLatestBlockhash().send()).value;
    cachedBlockhashAt = Date.now();
  }
  return cachedBlockhash;
}

async function send(feePayer, instructions) {
  let lastError = new Error("send failed");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const latest = await blockhash();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (current) => setTransactionMessageFeePayerSigner(feePayer, current),
        (current) =>
          setTransactionMessageLifetimeUsingBlockhash(latest, current),
        (current) => appendTransactionMessageInstructions(instructions, current)
      );
      const signed = await signTransactionMessageWithSigners(message);
      const signature = getSignatureFromTransaction(signed);
      const wire = getBase64EncodedWireTransaction(signed);
      const simulation = await rpc
        .simulateTransaction(wire, {
          encoding: "base64",
          commitment: "confirmed",
          sigVerify: true,
        })
        .send();
      if (simulation.value.err) {
        throw new Error(
          `simulation failed: ${JSON.stringify(simulation.value.err)} ${(simulation.value.logs ?? []).join(" | ")}`
        );
      }
      console.log(`simulation passed ${signature}`);
      await rpc
        .sendTransaction(wire, {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 3n,
        })
        .send();
      await wait(signature);
      return signature;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("send failed");
      cachedBlockhash = undefined;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function balance(publicKey) {
  const result = await rpc.getBalance(address(publicKey)).send();
  return result.value;
}

const NEEDED = 2_560_000_000n;

async function fund(publicKey) {
  let held = await balance(publicKey);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (held < NEEDED && Date.now() < deadline) {
    console.log(
      `waiting for deploy rent, have ${held.toString()} of ${NEEDED.toString()}`
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    held = await balance(publicKey);
  }
  return held;
}

async function account(publicKey) {
  const info = await rpc
    .getAccountInfo(address(publicKey), { encoding: "base64" })
    .send();
  return info.value;
}

async function deploy(payer, programSigner, elf) {
  const progressFile = "server/data/deploy-progress.json";
  let bufferSecret;
  let offset = 0;
  if (existsSync(progressFile)) {
    const progress = JSON.parse(readFileSync(progressFile, "utf8"));
    bufferSecret = Uint8Array.from(Buffer.from(progress.secretKey, "base64"));
    offset = progress.offset ?? 0;
  } else {
    bufferSecret = nacl.sign.keyPair().secretKey;
    saveSecret(progressFile, bufferSecret);
  }
  const buffer = await signerFrom(bufferSecret);
  const existing = await account(buffer.address);
  if (existing) {
    if (existing.owner !== LOADER || existing.executable)
      throw new Error("Invalid upload buffer owner");
    const bytes = Buffer.from(existing.data[0], "base64");
    if (
      bytes.length !== 37 + elf.length ||
      bytes.readUInt32LE(0) !== 1 ||
      bytes[4] !== 1 ||
      !bytes.subarray(5, 37).equals(Buffer.from(raw(payer.address)))
    ) {
      throw new Error(
        "Upload buffer size or authority does not match this deployment"
      );
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > elf.length ||
      !bytes.subarray(37, 37 + offset).equals(elf.subarray(0, offset))
    ) {
      throw new Error(
        "Saved upload progress does not match the on-chain program bytes"
      );
    }
    console.log(`verified upload prefix ${offset}/${elf.length}`);
  } else if (offset > 0) {
    throw new Error(
      "Saved upload buffer is missing; refusing to allocate another buffer"
    );
  }
  const space = 37 + elf.length;
  const rent = await rpc
    .getMinimumBalanceForRentExemption(BigInt(space))
    .send();
  if (!(await account(buffer.address))) {
    const created = addSignersToInstruction([payer, buffer], {
      programAddress: SYSTEM,
      accounts: [
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: buffer.address, role: AccountRole.WRITABLE_SIGNER },
      ],
      data: concat(u32(0), u64(rent), u64(space), raw(LOADER)),
    });
    const initialized = addSignersToInstruction([payer], {
      programAddress: LOADER,
      accounts: [
        { address: buffer.address, role: AccountRole.WRITABLE },
        { address: payer.address, role: AccountRole.READONLY_SIGNER },
      ],
      data: u32(0),
    });
    await send(payer, [created, initialized]);
    console.log(`buffer ${buffer.address}`);
  }
  const chunkSize = 1000;
  const inflight = new Set();
  const finished = new Map();
  let cursor = offset;
  let submitted = offset;
  const note = (start, length) => {
    finished.set(start, length);
    while (finished.has(cursor)) {
      const length = finished.get(cursor);
      finished.delete(cursor);
      cursor += length;
    }
    writeFileSync(
      progressFile,
      JSON.stringify({
        secretKey: Buffer.from(bufferSecret).toString("base64"),
        offset: cursor,
      })
    );
    if (cursor % 25000 < 1000) console.log(`wrote ${cursor}/${elf.length}`);
  };
  const writeChunk = async (start) => {
    const chunk = elf.subarray(start, start + chunkSize);
    const write = addSignersToInstruction([payer], {
      programAddress: LOADER,
      accounts: [
        { address: buffer.address, role: AccountRole.WRITABLE },
        { address: payer.address, role: AccountRole.READONLY_SIGNER },
      ],
      data: concat(u32(1), u32(start), u64(chunk.length), chunk),
    });
    await send(payer, [write]);
    note(start, chunk.length);
  };
  while (submitted < elf.length || inflight.size > 0) {
    while (submitted < elf.length && inflight.size < 1) {
      const start = submitted;
      submitted += Math.min(chunkSize, elf.length - start);
      const job = writeChunk(start).finally(() => inflight.delete(job));
      inflight.add(job);
    }
    if (inflight.size > 0) await Promise.race(inflight);
  }
  const [programData] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [raw(programSigner.address)],
  });
  const deployIx = addSignersToInstruction([payer, programSigner], {
    programAddress: LOADER,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: programData, role: AccountRole.WRITABLE },
      { address: programSigner.address, role: AccountRole.WRITABLE_SIGNER },
      { address: buffer.address, role: AccountRole.WRITABLE },
      { address: RENT, role: AccountRole.READONLY },
      { address: CLOCK, role: AccountRole.READONLY },
      { address: SYSTEM, role: AccountRole.READONLY },
      { address: payer.address, role: AccountRole.READONLY_SIGNER },
    ],
    data: concat(u32(2), u64(elf.length)),
  });
  const programRent = await rpc.getMinimumBalanceForRentExemption(36n).send();
  const createProgram = addSignersToInstruction([payer, programSigner], {
    programAddress: SYSTEM,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: programSigner.address, role: AccountRole.WRITABLE_SIGNER },
    ],
    data: concat(u32(0), u64(programRent), u64(36), raw(LOADER)),
  });
  const signature = await send(payer, [createProgram, deployIx]);
  console.log(`deployed ${signature}`);
}

async function bootstrapMint(payer, payerSecretBytes, policy, verifier) {
  const mintSecret = nacl.sign.keyPair().secretKey;
  const mint = await signerFrom(mintSecret);
  const mintRent = await rpc.getMinimumBalanceForRentExemption(82n).send();
  const createMint = addSignersToInstruction([payer, mint], {
    programAddress: SYSTEM,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: mint.address, role: AccountRole.WRITABLE_SIGNER },
    ],
    data: concat(u32(0), u64(mintRent), u64(82), raw(TOKEN)),
  });
  const initMint = {
    programAddress: TOKEN,
    accounts: [{ address: mint.address, role: AccountRole.WRITABLE }],
    data: concat(
      new Uint8Array([20, 6]),
      raw(payer.address),
      new Uint8Array([0])
    ),
  };
  await send(payer, [createMint, initMint]);
  saveSecret("server/data/mint-authority.json", payerSecretBytes);
  const program = address(PROGRAM_ID);
  const [config] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [getBytesEncoder().encode(new TextEncoder().encode("config"))],
  });
  const initialize = addSignersToInstruction([payer], {
    programAddress: program,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: config, role: AccountRole.WRITABLE },
      { address: mint.address, role: AccountRole.READONLY },
      { address: TOKEN, role: AccountRole.READONLY },
      { address: SYSTEM, role: AccountRole.READONLY },
    ],
    data: concat(
      disc("initialize"),
      raw(policy),
      raw(verifier),
      u64(1),
      u32(4095)
    ),
  });
  await send(payer, [initialize]);
  for (const route of CROSS_BORDER_ROUTES) {
    const [corridor] = await getProgramDerivedAddress({
      programAddress: program,
      seeds: [
        new TextEncoder().encode("corridor"),
        countrySeed(route.fromCountry),
        countrySeed(route.toCountry),
      ],
    });
    const corridorIx = addSignersToInstruction([payer], {
      programAddress: program,
      accounts: [
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: config, role: AccountRole.READONLY },
        { address: corridor, role: AccountRole.WRITABLE },
        { address: SYSTEM, role: AccountRole.READONLY },
      ],
      data: concat(
        disc("init_corridor"),
        countrySeed(route.fromCountry),
        countrySeed(route.toCountry),
        new Uint8Array([1]),
        u64(1_000_000),
        u64(10_000_000_000),
        u64(0)
      ),
    });
    await send(payer, [corridorIx]);
  }
  console.log(`mint ${mint.address}`);
  return mint.address;
}

writeFileSync(
  "server/data/deploy-status.json",
  JSON.stringify({ pid: process.pid, startedAt: Date.now() })
);

const programSecret = loadSecret("anchor/keys/leash-keypair.json");
const program = await signerFrom(programSecret);
if (program.address !== PROGRAM_ID)
  throw new Error("program key does not match the pinned address");
const payerFile = "server/data/devnet-payer.json";
const payerSecretBytes = existsSync(payerFile)
  ? loadSecret(payerFile)
  : nacl.sign.keyPair().secretKey;
if (!existsSync(payerFile)) saveSecret(payerFile, payerSecretBytes);
const payer = await signerFrom(payerSecretBytes);
console.log(`payer ${payer.address}`);
if (
  (await rpc.getGenesisHash().send()) !==
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
) {
  throw new Error("RPC is not devnet");
}
const resuming = existsSync("server/data/deploy-progress.json");
const held = resuming
  ? await balance(payer.address)
  : await fund(payer.address);
console.log(`payer balance ${held.toString()}`);
if (!resuming && held < NEEDED)
  throw new Error("deployer was not funded in time");
if (resuming && held < 5_000_000n)
  throw new Error("deployer does not have enough SOL left for upload fees");
if (!(await account(PROGRAM_ID))) {
  await deploy(payer, program, readFileSync("anchor/target/deploy/leash.so"));
} else {
  console.log("program already deployed");
}
const policy = (
  await signerFrom(loadSecret("server/data/policy.json", "LEASH_POLICY_SECRET"))
).address;
const verifier = (
  await signerFrom(
    loadSecret("server/data/verifier.json", "LEASH_VERIFIER_SECRET")
  )
).address;
console.log(`policy ${policy}`);
console.log(`verifier ${verifier}`);
if (await account("Fe7LKncY2gRuV7ucMfcNsATSyF8hZNN6L4HT85j9Wa8g")) {
  console.log("config already exists");
  console.log(
    "Check missing routes with node scripts/seed-corridors.mjs; initialize them separately after reviewing its simulations."
  );
} else {
  const mint = await bootstrapMint(payer, payerSecretBytes, policy, verifier);
  const envFile = ".env";
  const env = readFileSync(envFile, "utf8");
  const next = /LEASH_USDC_MINT=.*/.test(env)
    ? env.replace(/LEASH_USDC_MINT=.*/, `LEASH_USDC_MINT=${mint}`)
    : `${env.trim()}\nLEASH_USDC_MINT=${mint}\n`;
  writeFileSync(envFile, next);
  console.log("mint written to env");
}
