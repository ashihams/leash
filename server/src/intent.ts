import { concat, countryBytes } from "./bytes.ts";

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
  return concat([
    new TextEncoder().encode("LEASH_INTENT_V1"),
    Uint8Array.of(input.kind),
    input.paymentId,
    input.mandate,
    input.buyer,
    input.vendor,
    input.mint,
    u64(input.amount),
    countryBytes(input.fromCountry),
    countryBytes(input.toCountry),
    u16(input.category),
    u16(input.purposeCode),
    input.invoiceHash,
    u64(input.invoiceAmount),
  ]);
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
