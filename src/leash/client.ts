import {
  decodeBase58,
  encodeBase58,
  encodeHex,
} from "../../server/src/bytes.ts";
import { intentMessage } from "../../server/src/intent.ts";
import nacl from "tweetnacl";

export const GATE = import.meta.env.VITE_GATE_URL ?? "/gate";
export const USDC_DECIMALS = 1_000_000;
export const PROGRAM_ID = "8Eq2Ug3URR5ugzDfjYk4bbkBJa8o7U6YZtPp6vLDHezd";

export type GateResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function gate(
  path: string,
  payload?: unknown
): Promise<GateResult> {
  const response = await fetch(`${GATE}${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers:
      payload === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

export function pubkey(bytes: Uint8Array): string {
  return encodeBase58(bytes);
}

export function signIntent(
  secretKey: Uint8Array,
  input: {
    kind: number;
    paymentId: string;
    mandate: string;
    buyer: string;
    vendor: string;
    mint: string;
    amount: number;
    invoiceHash: string;
  }
): string {
  const message = intentMessage({
    kind: input.kind,
    paymentId: hexToBytes(input.paymentId),
    mandate: decodeBase58(input.mandate),
    buyer: decodeBase58(input.buyer),
    vendor: decodeBase58(input.vendor),
    mint: decodeBase58(input.mint),
    amount: input.amount,
    fromCountry: "US",
    toCountry: "US",
    category: 7,
    purposeCode: 1001,
    invoiceHash: hexToBytes(input.invoiceHash),
    invoiceAmount: input.amount,
  });
  const signature = nacl.sign.detached(message, secretKey);
  return bytesToBase64(signature);
}

export function randomHex(size = 32): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return encodeHex(bytes);
}

export function hexToBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return encodeHex(new Uint8Array(digest));
}

export function usdcToBase(value: number): number {
  return Math.round(value * USDC_DECIMALS);
}

export function baseToUsdc(value: number): string {
  return (value / USDC_DECIMALS).toFixed(2);
}
