const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function encodeBase58(source: Uint8Array): string {
  if (source.length === 0) return "";
  const digits = [0];
  for (let i = 0; i < source.length; i++) {
    let carry = source[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; source[i] === 0 && i < source.length - 1; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  const bytes = [0];
  for (let i = 0; i < value.length; i++) {
    const digit = ALPHABET.indexOf(value[i]);
    if (digit < 0) throw new Error("BAD_BASE58");
    for (let j = 0; j < bytes.length; j++) bytes[j] *= 58;
    bytes[0] += digit;
    let carry = 0;
    for (let j = 0; j < bytes.length; j++) {
      bytes[j] += carry;
      carry = bytes[j] >> 8;
      bytes[j] &= 0xff;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; value[i] === "1" && i < value.length - 1; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

export function encodeHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function decodeHex(value: string, length: number): Uint8Array {
  if (value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error("BAD_HEX");
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

export function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function countryBytes(code: string): Uint8Array {
  if (!/^[A-Z]{2}$/.test(code)) throw new Error("BAD_COUNTRY");
  return Uint8Array.from(Buffer.from(code, "ascii"));
}
