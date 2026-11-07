import nacl from "tweetnacl";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type WalletTokenClaims = {
  wallet: string;
  purpose: string;
  iat: number;
  exp: number;
};

export function walletKeyPair(seed: Uint8Array) {
  if (seed.length !== 32) {
    throw new Error("WALLET_AUTH_SECRET must decode to 32 bytes.");
  }
  return nacl.sign.keyPair.fromSeed(seed);
}

export function signWalletToken(
  secretKey: Uint8Array,
  claims: WalletTokenClaims,
): string {
  const payload = JSON.stringify(claims);
  const payloadBytes = textEncoder.encode(payload);
  const signature = nacl.sign.detached(payloadBytes, secretKey);
  return `${encode(payloadBytes)}.${encode(signature)}`;
}

export function readWalletToken(
  publicKey: Uint8Array,
  token: string,
  nowSeconds: number,
): WalletTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payloadBytes = decode(parts[0]);
  const signature = decode(parts[1]);
  if (!payloadBytes || !signature || signature.length !== 64) return null;
  if (!nacl.sign.detached.verify(payloadBytes, signature, publicKey)) return null;
  let claims: WalletTokenClaims;
  try {
    claims = JSON.parse(textDecoder.decode(payloadBytes)) as WalletTokenClaims;
  } catch {
    return null;
  }
  if (
    typeof claims.wallet !== "string" ||
    typeof claims.purpose !== "string" ||
    typeof claims.exp !== "number" ||
    claims.exp <= nowSeconds
  ) {
    return null;
  }
  return claims;
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0) return null;
    return bytes;
  } catch {
    return null;
  }
}
