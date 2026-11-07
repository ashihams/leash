export const APP_NAME = "Leash";
export const NONCE_TTL_SECONDS = 60;
export const WALLET_TOKEN_TTL_SECONDS = 15 * 60;
export const REVIEW_TIMEOUT_SECONDS = 15 * 60;

export const WALLET_PURPOSES = [
  "buyer_auth",
  "vendor_auth",
  "intent",
  "link_wallet",
  "review",
] as const;

export type WalletPurpose = (typeof WALLET_PURPOSES)[number];

export function challengeMessage(input: {
  wallet: string;
  purpose: WalletPurpose;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}): string {
  return [
    APP_NAME,
    `wallet:${input.wallet}`,
    `purpose:${input.purpose}`,
    `nonce:${input.nonce}`,
    `issued_at:${input.issuedAt}`,
    `expires_at:${input.expiresAt}`,
  ].join("\n");
}

export function reviewMessage(input: {
  wallet: string;
  paymentId: string;
  decision: "approved" | "denied";
  nonce: string;
}): string {
  return [
    "Leash review",
    `wallet:${input.wallet}`,
    `payment_id:${input.paymentId}`,
    `decision:${input.decision}`,
    `nonce:${input.nonce}`,
  ].join("\n");
}
