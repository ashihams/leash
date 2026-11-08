export type ScreenResult = {
  listed: boolean;
  supported: boolean;
  providerRef?: string;
  raw: unknown;
};

export interface SanctionsScreeningProvider {
  screenWallet(wallet: string): Promise<ScreenResult>;
  health(): Promise<boolean>;
}

export type VerificationSession = {
  sessionId: string;
  url: string;
  status: string;
};

export type WebhookVerdict =
  | {
      ok: true;
      eventId: string;
      sessionId: string;
      vendorWallet: string;
      status: string;
      environment: string;
      expiresAt: string | null;
    }
  | { ok: false; statusCode: 401; code: string };

export interface IdentityVerificationProvider {
  getDecision(
    sessionId: string,
    vendorWallet: string
  ): Promise<{ status: string; expiresAt: string | null }>;
  createSession(vendorWallet: string): Promise<VerificationSession>;
  ping(): Promise<void>;
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    nowSeconds: number
  ): WebhookVerdict;
}
