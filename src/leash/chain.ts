import {
  AccountRole,
  address,
  createNoopSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBytesEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  partiallySignTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from "@solana/kit";
import { DEVNET_GENESIS_HASH } from "./wallet.ts";
export const DEVNET_RPC = "https://api.devnet.solana.com";
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const ED25519_PROGRAM = address("Ed25519SigVerify111111111111111111111111111");
const INSTRUCTIONS = address("Sysvar1nstructions1111111111111111111111111");
const PROGRAM = address("8Eq2Ug3URR5ugzDfjYk4bbkBJa8o7U6YZtPp6vLDHezd");

const rpc = createSolanaRpc(DEVNET_RPC);

export function explorerTx(signature: string) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export class ChainRejected extends Error {
  signature: string;
  constructor(message: string, signature: string) {
    super(message);
    this.signature = signature;
  }
}

type ChainAccount = { address: Address; role: AccountRole };

function ix(programAddress: Address, accounts: ChainAccount[], data: Uint8Array): Instruction {
  return { programAddress, accounts, data };
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16(value: number) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value: number) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64(value: number | bigint) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function i64(value: number) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
  return out;
}

async function discriminator(name: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`global:${name}`),
  );
  return new Uint8Array(digest).slice(0, 8);
}

async function pda(seeds: Uint8Array[]): Promise<Address> {
  const [derived] = await getProgramDerivedAddress({
    programAddress: PROGRAM,
    seeds,
  });
  return derived;
}

function textSeed(value: string) {
  return Uint8Array.from(getBytesEncoder().encode(new TextEncoder().encode(value)));
}

function addressSeed(value: string) {
  return Uint8Array.from(getAddressEncoder().encode(address(value)));
}

export async function configPda() {
  return pda([textSeed("config")]);
}

export async function corridorPda() {
  return pda([textSeed("corridor"), new Uint8Array([85, 83]), new Uint8Array([85, 83])]);
}

export async function treasuryPda(mandate: string) {
  return pda([textSeed("treasury"), addressSeed(mandate)]);
}

export async function treasuryVaultPda(mandate: string) {
  return pda([textSeed("treasury-vault"), addressSeed(mandate)]);
}

export async function escrowPda(paymentId: Uint8Array) {
  return pda([textSeed("escrow"), paymentId]);
}

export async function escrowVaultPda(paymentId: Uint8Array) {
  return pda([textSeed("escrow-vault"), paymentId]);
}

export async function ataPda(owner: string, mint: string) {
  const [derived] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [addressSeed(owner), addressSeed(TOKEN_PROGRAM), addressSeed(mint)],
  });
  return derived;
}

export function ed25519InstructionData(
  signature: Uint8Array,
  pubkey: Uint8Array,
  message: Uint8Array,
) {
  const signatureOffset = 16;
  const pubkeyOffset = signatureOffset + 64;
  const messageOffset = pubkeyOffset + 32;
  const data = new Uint8Array(messageOffset + message.length);
  const view = new DataView(data.buffer);
  data[0] = 1;
  view.setUint16(2, signatureOffset, true);
  view.setUint16(4, 0xffff, true);
  view.setUint16(6, pubkeyOffset, true);
  view.setUint16(8, 0xffff, true);
  view.setUint16(10, messageOffset, true);
  view.setUint16(12, message.length, true);
  view.setUint16(14, 0xffff, true);
  data.set(signature, signatureOffset);
  data.set(pubkey, pubkeyOffset);
  data.set(message, messageOffset);
  return data;
}

export function ed25519Instruction(data: Uint8Array): Instruction {
  return ix(ED25519_PROGRAM, [], data);
}

function accountData(data: unknown) {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data) && typeof data[0] === "string") {
    const binary = atob(data[0]);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array();
}

function withTimeout<T>(work: Promise<T>, ms = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Devnet took too long to answer.")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const DEPLOYER = "8ZBVLivQLgxqUpxV9z8nLWJZwpvZsXqgMmXJkAUavwrU";
const PROGRAM_BUFFER = "7JopWxRxNSKJQEpT2tVqo4kQCo2FMNP4x6Uj1MxmcGZN";
export const DEPLOY_LAMPORTS = 2_560_000_000;

let programReady: Promise<boolean> | undefined;

export async function programIsDeployed() {
  if (programReady) return programReady;
  const info = await withTimeout(rpc.getAccountInfo(PROGRAM, { encoding: "base64", commitment: "confirmed" }).send());
  const ready = info.value?.executable === true && info.value.owner === "BPFLoaderUpgradeab1e11111111111111111111111";
  if (ready) programReady = Promise.resolve(true);
  return ready;
}

export async function deployRentPaid() {
  if (await accountExists(PROGRAM_BUFFER).catch(() => false)) return true;
  const held = await lamportBalance(DEPLOYER);
  return held >= BigInt(DEPLOY_LAMPORTS);
}

export async function deployerShortfall() {
  if (await deployRentPaid()) return 0n;
  const held = await lamportBalance(DEPLOYER);
  const need = BigInt(DEPLOY_LAMPORTS);
  return held >= need ? 0n : need - held;
}

export async function confirmSignature(signature: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await withTimeout(
      rpc.getSignatureStatuses([signature as Parameters<typeof rpc.getSignatureStatuses>[0][0]]).send(),
    );
    const value = status.value[0];
    if (value?.err) throw new ChainRejected(`Transaction rejected: ${JSON.stringify(value.err)}`, signature);
    if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new ChainRejected("Transaction confirmation timed out. Check the explorer before retrying.", signature);
}

export async function accountExists(account: string) {
  const info = await withTimeout(rpc.getAccountInfo(address(account), { encoding: "base64" }).send());
  return info.value !== null;
}

export async function tokenAmount(account: string) {
  const info = await withTimeout(rpc.getAccountInfo(address(account), { encoding: "base64" }).send());
  if (!info.value) return 0;
  const data = accountData(info.value.data);
  if (data.length < 72) return 0;
  return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true));
}

export async function lamportBalance(publicKey: string) {
  const balance = await withTimeout(rpc.getBalance(address(publicKey)).send());
  return balance.value;
}

export function transferSolInstruction(from: string, to: string, amount: number): Instruction {
  return ix(
    SYSTEM_PROGRAM,
    [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    concat(u32(2), u64(amount)),
  );
}

export async function fundIfNeeded(publicKey: string) {
  try {
    return await ensureLamports(address(publicKey));
  } catch {
    return null;
  }
}

async function ensureLamports(publicKey: Address) {
  const balance = await withTimeout(rpc.getBalance(publicKey).send());
  if (balance.value >= 50_000_000n) return null;
  try {
    return await withTimeout(rpc.requestAirdrop(publicKey, lamports(1_000_000_000n)).send(), 4000);
  } catch {
    return null;
  }
}

let genesisCheck: Promise<void> | undefined;

export function assertDevnetRpc() {
  genesisCheck ??= (async () => {
    try {
      const hash = await withTimeout(rpc.getGenesisHash().send());
      if (hash !== DEVNET_GENESIS_HASH) throw new Error("RPC is not devnet");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "RPC is not devnet") {
        genesisCheck = undefined;
      }
      throw error;
    }
  })();
  return genesisCheck;
}

export async function devnetRpcMatches() {
  try {
    await assertDevnetRpc();
    return true;
  } catch (error) {
    return error instanceof Error && error.message === "RPC is not devnet" ? false : null;
  }
}

type PreparedTransaction = Awaited<ReturnType<typeof partiallySignTransactionMessageWithSigners>>;

export async function sendSignedByWallet(
  signTransaction: (transaction: PreparedTransaction) => Promise<unknown>,
  instructions: Instruction[],
  feePayer: string,
) {
  await assertDevnetRpc();
  const signer = createNoopSigner(address(feePayer));
  const { value: latest } = await withTimeout(rpc.getLatestBlockhash().send());
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(signer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latest, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const prepared = await partiallySignTransactionMessageWithSigners(message);
  const signed = (await signTransaction(prepared)) as PreparedTransaction;
  const signature = getSignatureFromTransaction(signed);
  await withTimeout(
    rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3n,
      })
      .send(),
  );
  await confirmSignature(signature);
  return signature;
}

export async function sendLocal(secretKey: Uint8Array, instructions: Instruction[]) {
  await assertDevnetRpc();
  if (!(await programIsDeployed())) {
    throw new Error("The Leash program is not on devnet yet, so no transaction was sent.");
  }
  const signer = await createKeyPairSignerFromBytes(secretKey);
  const airdrop = await fundIfNeeded(signer.address);
  if ((await withTimeout(rpc.getBalance(signer.address).send())).value < 5_000n) {
    throw new Error(
      "This key has no devnet SOL. Connect a wallet that already has devnet SOL. The public faucet no longer airdrops without a GitHub sign-in.",
    );
  }
  const { value: latest } = await withTimeout(rpc.getLatestBlockhash().send());
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayerSigner(signer, current),
    (current) => setTransactionMessageLifetimeUsingBlockhash(latest, current),
    (current) => appendTransactionMessageInstructions(instructions, current),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  try {
    await withTimeout(
      rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), {
          encoding: "base64",
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 3n,
        })
        .send(),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "The transaction was rejected before it landed.";
    throw new Error(reason);
  }
  await confirmSignature(signature);
  return { signature, airdrop };
}

export async function createMandateInstruction(input: {
  owner: string;
  mandate: string;
  mandateId: number;
  agent: string;
  mint: string;
  budget: number;
  perPayment: number;
  expiresAt: number;
}) {
  const params = concat(
    addressSeed(input.agent),
    u64(input.budget),
    u64(input.perPayment),
    u32(4),
    i64(input.expiresAt),
    i64(3600),
    i64(3600),
    u16(7),
    u32(1),
    new Uint8Array([85, 83, 85, 83]),
  );
  return ix(
    PROGRAM,
    [
      { address: address(input.owner), role: AccountRole.WRITABLE_SIGNER },
      { address: address(input.mandate), role: AccountRole.WRITABLE },
      { address: await treasuryPda(input.mandate), role: AccountRole.READONLY },
      { address: await treasuryVaultPda(input.mandate), role: AccountRole.WRITABLE },
      { address: address(input.mint), role: AccountRole.READONLY },
      { address: await configPda(), role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    concat(await discriminator("create_mandate"), u64(input.mandateId), params),
  );
}

export async function createAtaInstruction(payer: string, owner: string, mint: string) {
  return ix(
    ATA_PROGRAM,
    [
      { address: address(payer), role: AccountRole.WRITABLE_SIGNER },
      { address: await ataPda(owner, mint), role: AccountRole.WRITABLE },
      { address: address(owner), role: AccountRole.READONLY },
      { address: address(mint), role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    new Uint8Array([1]),
  );
}

export async function depositInstruction(input: {
  owner: string;
  mandate: string;
  mandateId: number;
  mint: string;
  amount: number;
}) {
  return ix(
    PROGRAM,
    [
      { address: address(input.owner), role: AccountRole.READONLY_SIGNER },
      { address: address(input.mandate), role: AccountRole.READONLY },
      { address: await ataPda(input.owner, input.mint), role: AccountRole.WRITABLE },
      { address: await treasuryVaultPda(input.mandate), role: AccountRole.WRITABLE },
      { address: address(input.mint), role: AccountRole.READONLY },
      { address: await configPda(), role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    concat(await discriminator("deposit"), u64(input.mandateId), u64(input.amount)),
  );
}

export async function fundInstructions(input: {
  agent: string;
  owner: string;
  mandate: string;
  mandateId: number;
  mint: string;
  vendor: string;
  paymentId: Uint8Array;
  ed25519: Uint8Array;
}) {
  const program = ix(
    PROGRAM,
    [
      { address: address(input.agent), role: AccountRole.WRITABLE_SIGNER },
      { address: address(input.owner), role: AccountRole.READONLY },
      { address: address(input.mandate), role: AccountRole.WRITABLE },
      { address: await configPda(), role: AccountRole.READONLY },
      { address: await corridorPda(), role: AccountRole.WRITABLE },
      { address: await treasuryPda(input.mandate), role: AccountRole.READONLY },
      { address: await treasuryVaultPda(input.mandate), role: AccountRole.WRITABLE },
      { address: await escrowPda(input.paymentId), role: AccountRole.WRITABLE },
      { address: await escrowVaultPda(input.paymentId), role: AccountRole.WRITABLE },
      { address: address(input.mint), role: AccountRole.READONLY },
      { address: address(input.vendor), role: AccountRole.READONLY },
      { address: INSTRUCTIONS, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    concat(
      await discriminator("create_and_fund"),
      input.paymentId,
      u64(input.mandateId),
      new Uint8Array([85, 83]),
      new Uint8Array([85, 83]),
    ),
  );
  return [ed25519Instruction(input.ed25519), program];
}

export async function submitDeliveryInstruction(input: {
  vendor: string;
  owner: string;
  mandate: string;
  mandateId: number;
  paymentId: Uint8Array;
  receiptHash: Uint8Array;
}) {
  return ix(
    PROGRAM,
    [
      { address: address(input.vendor), role: AccountRole.READONLY_SIGNER },
      { address: address(input.owner), role: AccountRole.READONLY },
      { address: address(input.mandate), role: AccountRole.READONLY },
      { address: await escrowPda(input.paymentId), role: AccountRole.WRITABLE },
    ],
    concat(
      await discriminator("submit_delivery"),
      input.paymentId,
      u64(input.mandateId),
      input.receiptHash,
    ),
  );
}

export async function verifyInstruction(input: {
  verifier: string;
  paymentId: Uint8Array;
  artifact: Uint8Array;
}) {
  return ix(
    PROGRAM,
    [
      { address: address(input.verifier), role: AccountRole.READONLY_SIGNER },
      { address: await configPda(), role: AccountRole.READONLY },
      { address: await escrowPda(input.paymentId), role: AccountRole.WRITABLE },
    ],
    concat(await discriminator("verify_delivery"), input.paymentId, u32(input.artifact.length), input.artifact),
  );
}

export async function releaseInstructions(input: {
  agent: string;
  vendor: string;
  mint: string;
  paymentId: Uint8Array;
  ed25519: Uint8Array;
}) {
  const program = ix(
    PROGRAM,
    [
      { address: address(input.agent), role: AccountRole.WRITABLE_SIGNER },
      { address: await escrowPda(input.paymentId), role: AccountRole.WRITABLE },
      { address: await escrowVaultPda(input.paymentId), role: AccountRole.WRITABLE },
      { address: await configPda(), role: AccountRole.READONLY },
      { address: await corridorPda(), role: AccountRole.READONLY },
      { address: address(input.vendor), role: AccountRole.READONLY },
      { address: await ataPda(input.vendor, input.mint), role: AccountRole.WRITABLE },
      { address: address(input.mint), role: AccountRole.READONLY },
      { address: INSTRUCTIONS, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: ATA_PROGRAM, role: AccountRole.READONLY },
    ],
    concat(await discriminator("release"), input.paymentId),
  );
  const ata = await accountExists(await ataPda(input.vendor, input.mint));
  return ata
    ? [ed25519Instruction(input.ed25519), program]
    : [await createAtaInstruction(input.agent, input.vendor, input.mint), ed25519Instruction(input.ed25519), program];
}

export async function revokeInstruction(input: { owner: string; mandate: string; mandateId: number }) {
  return ix(
    PROGRAM,
    [
      { address: address(input.owner), role: AccountRole.READONLY_SIGNER },
      { address: address(input.mandate), role: AccountRole.WRITABLE },
    ],
    concat(await discriminator("revoke_mandate"), u64(input.mandateId)),
  );
}

export async function mintToInstruction(input: {
  authority: string;
  mint: string;
  owner: string;
  amount: number;
}) {
  const destination = await ataPda(input.owner, input.mint);
  const instructions: Instruction[] = [];
  if (!(await accountExists(destination))) {
    instructions.push(await createAtaInstruction(input.authority, input.owner, input.mint));
  }
  instructions.push(
    ix(
      TOKEN_PROGRAM,
      [
        { address: address(input.mint), role: AccountRole.WRITABLE },
        { address: destination, role: AccountRole.WRITABLE },
        { address: address(input.authority), role: AccountRole.READONLY_SIGNER },
      ],
      concat(new Uint8Array([7]), u64(input.amount)),
    ),
  );
  return instructions;
}
