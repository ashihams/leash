import { ProviderHttpError, providerRequest } from "./http.ts";

export type RangeOutcome =
  | { status: "fail"; reasonCode: "LIST_MATCH_WALLET" }
  | { status: "pass" }
  | { status: "unavailable"; reasonCode: "CHECK_UNAVAILABLE" };

export class RangeSanctions {
  private readonly cache = new Map<string, RangeOutcome>();
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async screen(address: string): Promise<RangeOutcome> {
    const cached = this.cache.get(address);
    if (cached) return cached;
    let outcome: RangeOutcome;
    try {
      const response = await providerRequest(
        `https://api.range.org/v1/risk/sanctions/${encodeURIComponent(address)}`,
        {
          method: "GET",
          headers: { "X-API-KEY": this.apiKey, accept: "application/json" },
        },
        this.fetchImpl,
      );
      outcome = interpretRange(response.status, response.body);
    } catch (error) {
      if (!(error instanceof ProviderHttpError)) throw error;
      outcome = { status: "unavailable", reasonCode: "CHECK_UNAVAILABLE" };
    }
    this.cache.set(address, outcome);
    return outcome;
  }
}

export function interpretRange(status: number, body: unknown): RangeOutcome {
  if (status < 200 || status >= 300 || !body || typeof body !== "object") {
    return { status: "unavailable", reasonCode: "CHECK_UNAVAILABLE" };
  }
  const record = body as {
    lists_checked?: unknown;
    is_sanctioned?: unknown;
    is_token_blacklisted?: unknown;
  };
  if (record.lists_checked === false || record.is_sanctioned === null) {
    return { status: "unavailable", reasonCode: "CHECK_UNAVAILABLE" };
  }
  if (record.is_sanctioned === true || record.is_token_blacklisted === true) {
    return { status: "fail", reasonCode: "LIST_MATCH_WALLET" };
  }
  if (record.lists_checked !== true || record.is_sanctioned !== false) {
    return { status: "unavailable", reasonCode: "CHECK_UNAVAILABLE" };
  }
  return { status: "pass" };
}
