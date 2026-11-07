import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { concat, countryBytes, isZero } from "./bytes.ts";

export const CLEARANCE_LEN = 288;
export const VERSION = 1;
export const KIND_FUND = 1;
export const KIND_RELEASE = 2;
export const DECISION_DENY = 0;
export const DECISION_ALLOW = 1;
export const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111";

export const CHECK_BUYER_AUTH = 1 << 0;
export const CHECK_VENDOR_AUTH = 1 << 1;
export const CHECK_NONCE = 1 << 2;
export const CHECK_INTENT_SIG = 1 << 3;
export const CHECK_VENDOR_REGISTERED = 1 << 4;
export const CHECK_MANDATE = 1 << 5;
export const CHECK_CATEGORY = 1 << 6;
export const CHECK_MINT = 1 << 7;
export const CHECK_NOT_SELF = 1 << 8;
export const CHECK_CORRIDOR = 1 << 9;
export const CHECK_VELOCITY = 1 << 10;
export const CHECK_SCREENING = 1 << 11;
export const REQUIRED_CHECKS = (1 << 12) - 1;

const OFFSET_AMOUNT = 164;
const OFFSET_CURRENCY = 220;

export type ClearanceFields = {
  kind: number;
  decision: number;
  paymentId: Uint8Array;
  mandate: Uint8Array;
  buyer: Uint8Array;
  vendor: Uint8Array;
  mint: Uint8Array;
  amount: number;
  fromCountry: string;
  toCountry: string;
  category: number;
  purposeCode: number;
  invoiceHash: Uint8Array;
  invoiceAmount: number;
  policyVersion: number;
  issuedAt: number;
  expiresAt: number;
  checksRun: number;
  checksFailed: number;
  packetHash: Uint8Array;
};

export function encodeClearance(fields: ClearanceFields): Uint8Array {
  const out = new Uint8Array(CLEARANCE_LEN);
  const view = new DataView(out.buffer);
  out[0] = VERSION;
  out[1] = fields.kind;
  out[2] = fields.decision;
  write(out, 4, fields.paymentId, 32);
  write(out, 36, fields.mandate, 32);
  write(out, 68, fields.buyer, 32);
  write(out, 100, fields.vendor, 32);
  write(out, 132, fields.mint, 32);
  view.setBigUint64(OFFSET_AMOUNT, BigInt(fields.amount), true);
  write(out, 172, countryBytes(fields.fromCountry), 2);
  write(out, 174, countryBytes(fields.toCountry), 2);
  view.setUint16(176, fields.category, true);
  view.setUint16(178, fields.purposeCode, true);
  write(out, 180, fields.invoiceHash, 32);
  view.setBigUint64(212, BigInt(fields.invoiceAmount), true);
  out[OFFSET_CURRENCY] = 0x55;
  out[OFFSET_CURRENCY + 1] = 0x53;
  out[OFFSET_CURRENCY + 2] = 0x44;
  view.setBigUint64(224, BigInt(fields.policyVersion), true);
  view.setBigInt64(232, BigInt(fields.issuedAt), true);
  view.setBigInt64(240, BigInt(fields.expiresAt), true);
  view.setUint32(248, fields.checksRun, true);
  view.setUint32(252, fields.checksFailed, true);
  write(out, 256, fields.packetHash, 32);
  return out;
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

export function signClearance(
  message: Uint8Array,
  secretKey: Uint8Array
): Uint8Array {
  return nacl.sign.detached(message, secretKey);
}

export function ed25519InstructionData(
  signature: Uint8Array,
  pubkey: Uint8Array,
  message: Uint8Array
): Uint8Array {
  const signatureOffset = 16;
  const pubkeyOffset = signatureOffset + 64;
  const messageOffset = pubkeyOffset + 32;
  const data = new Uint8Array(messageOffset + message.length);
  const view = new DataView(data.buffer);
  data[0] = 1;
  data[1] = 0;
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

export function packetMissing(
  packetHash: Uint8Array,
  amount: number,
  threshold: number
): boolean {
  return threshold > 0 && amount >= threshold && isZero(packetHash);
}

export function intentMessage(input: {
  kind: number;
  paymentId: Uint8Array;
  mandate: Uint8Array;
  buyer: Uint8Array;
  vendor: Uint8Array;
  mint: Uint8Array;
  amount: number;
  fromCountry: string;
  toCountry: string;
  category: number;
  purposeCode: number;
  invoiceHash: Uint8Array;
  invoiceAmount: number;
}): Uint8Array {
  const amount = u64(input.amount);
  const invoiceAmount = u64(input.invoiceAmount);
  const category = u16(input.category);
  const purpose = u16(input.purposeCode);
  return concat([
    Buffer.from("LEASH_INTENT_V1"),
    Uint8Array.of(input.kind),
    input.paymentId,
    input.mandate,
    input.buyer,
    input.vendor,
    input.mint,
    amount,
    countryBytes(input.fromCountry),
    countryBytes(input.toCountry),
    category,
    purpose,
    input.invoiceHash,
    invoiceAmount,
  ]);
}

function write(
  out: Uint8Array,
  offset: number,
  bytes: Uint8Array,
  length: number
) {
  if (bytes.length !== length) throw new Error("BAD_WIDTH");
  out.set(bytes, offset);
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}
