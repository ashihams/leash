import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderHttpError, providerRequest } from "./http.ts";
import type {
  IdentityVerificationProvider,
  VerificationSession,
  WebhookVerdict,
} from "./types.ts";

const DIDIT_BASE = "https://verification.didit.me";
const MAX_SKEW_SECONDS = 300;

const STATUS = {
  verified: "Approved",
  review: "In Review",
  declined: "Declined",
  kycExpired: "Kyc Expired",
} as const;

export class DiditIdentity implements IdentityVerificationProvider {
  private readonly apiKey: string;
  private readonly workflowId: string;
  private readonly webhookSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    apiKey: string,
    workflowId: string,
    webhookSecret: string,
    fetchImpl: typeof fetch = fetch
  ) {
    this.apiKey = apiKey;
    this.workflowId = workflowId;
    this.webhookSecret = webhookSecret;
    this.fetchImpl = fetchImpl;
  }

  async ping(): Promise<void> {
    const response = await providerRequest(
      `${DIDIT_BASE}/v3/session/00000000-0000-0000-0000-000000000000/decision/`,
      { method: "GET", headers: { "x-api-key": this.apiKey } },
      this.fetchImpl
    );
    if (
      response.status !== 404 &&
      (response.status < 200 || response.status >= 300)
    )
      throw new ProviderHttpError("HTTP");
  }

  async getDecision(sessionId: string, vendorWallet: string) {
    const response = await providerRequest(
      `${DIDIT_BASE}/v3/session/${encodeURIComponent(sessionId)}/decision/`,
      { method: "GET", headers: { "x-api-key": this.apiKey } },
      this.fetchImpl
    );
    if (response.status < 200 || response.status >= 300)
      throw new ProviderHttpError("HTTP");
    const body = response.body as Record<string, unknown> | null;
    if (
      !body ||
      body.session_id !== sessionId ||
      body.vendor_data !== vendorWallet ||
      typeof body.status !== "string" ||
      (body.workflow_id !== undefined && body.workflow_id !== this.workflowId)
    )
      throw new ProviderHttpError("MALFORMED");
    return { status: body.status, expiresAt: null };
  }

  async createSession(vendorWallet: string): Promise<VerificationSession> {
    const response = await providerRequest(
      `${DIDIT_BASE}/v3/session/`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify({
          workflow_id: this.workflowId,
          vendor_data: vendorWallet,
        }),
      },
      this.fetchImpl
    );
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderHttpError("HTTP");
    }
    const body = response.body as {
      session_id?: unknown;
      url?: unknown;
      status?: unknown;
    };
    if (
      !body ||
      typeof body.session_id !== "string" ||
      typeof body.url !== "string" ||
      typeof body.status !== "string"
    ) {
      throw new ProviderHttpError("MALFORMED");
    }
    return { sessionId: body.session_id, url: body.url, status: body.status };
  }

  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    nowSeconds: number
  ): WebhookVerdict {
    const signature = header(headers, "x-signature");
    const timestamp = header(headers, "x-timestamp");
    if (!signature || !timestamp)
      return { ok: false, statusCode: 401, code: "UNSIGNED" };
    const issued = Number(timestamp);
    if (
      !Number.isFinite(issued) ||
      Math.abs(nowSeconds - issued) > MAX_SKEW_SECONDS
    ) {
      return { ok: false, statusCode: 401, code: "STALE" };
    }
    const expected = createHmac("sha256", this.webhookSecret)
      .update(rawBody)
      .digest("hex");
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return { ok: false, statusCode: 401, code: "SIGNATURE_INVALID" };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { ok: false, statusCode: 401, code: "MALFORMED" };
    }
    const sessionId = stringField(parsed, "session_id");
    const status = stringField(parsed, "status");
    const vendorWallet = stringField(parsed, "vendor_data");
    if (!sessionId || !status || !vendorWallet) {
      return { ok: false, statusCode: 401, code: "MALFORMED" };
    }
    const eventId =
      stringField(parsed, "event_id") ??
      createHmac("sha256", "event").update(rawBody).digest("hex");
    const environment = stringField(parsed, "environment");
    return {
      ok: true,
      eventId,
      sessionId,
      vendorWallet,
      status,
      environment:
        environment === "sandbox" || environment === "live"
          ? environment
          : "unspecified",
      expiresAt: null,
    };
  }
}

export function identityCheck(input: {
  record: { status: string; expiresAt: string | null } | null;
  nowMs: number;
}): { status: "pass" | "flag" | "fail"; reasonCode: string } {
  if (!input.record)
    return { status: "fail", reasonCode: "VENDOR_NOT_REGISTERED" };
  if (
    input.record.expiresAt &&
    Date.parse(input.record.expiresAt) <= input.nowMs
  ) {
    return { status: "fail", reasonCode: "VENDOR_CREDENTIAL_EXPIRED" };
  }
  switch (input.record.status) {
    case STATUS.verified:
      return { status: "pass", reasonCode: "" };
    case STATUS.review:
      return { status: "flag", reasonCode: "REVIEW_STARTED" };
    case STATUS.declined:
      return { status: "fail", reasonCode: "VENDOR_CREDENTIAL_INVALID" };
    case STATUS.kycExpired:
      return { status: "fail", reasonCode: "VENDOR_CREDENTIAL_EXPIRED" };
    default:
      return { status: "flag", reasonCode: "SESSION_OPEN" };
  }
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function stringField(
  body: Record<string, unknown>,
  key: string
): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
