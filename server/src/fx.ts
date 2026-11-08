import type { FastifyInstance } from "fastify";
import {
  CROSS_BORDER_ROUTES,
  type FxQuote,
} from "../../src/leash/corridors.ts";

const CURRENCIES = new Set<string>(
  CROSS_BORDER_ROUTES.map((route) => route.currency)
);
export class MarketRates {
  private cached:
    { rates: Record<string, number>; fetchedAt: number } | undefined;
  private pending: Promise<void> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async quote(currency: string): Promise<FxQuote> {
    if (!CURRENCIES.has(currency)) throw new Error("UNSUPPORTED_CURRENCY");
    if (!this.cached || this.now() - this.cached.fetchedAt >= 60_000) {
      this.pending ??= this.refresh().finally(() => {
        this.pending = undefined;
      });
      await this.pending;
    }
    const cached = this.cached!;
    return {
      base: "USDC",
      currency,
      rate: cached.rates[currency],
      usdRate: cached.rates.USD,
      source: "Coinbase",
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
      expiresAt: new Date(cached.fetchedAt + 60_000).toISOString(),
    };
  }

  private async refresh() {
    const response = await this.fetchImpl(
      "https://api.coinbase.com/v2/exchange-rates?currency=USDC",
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
      }
    );
    if (!response.ok) throw new Error("FX_UNAVAILABLE");
    const body = (await response.json()) as {
      data?: { currency?: string; rates?: Record<string, unknown> };
    };
    if (body?.data?.currency !== "USDC" || !body.data.rates)
      throw new Error("FX_UNAVAILABLE");
    const rates: Record<string, number> = {};
    for (const currency of ["USD", ...CURRENCIES]) {
      const raw = body.data.rates[currency];
      if (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw))
        throw new Error("FX_UNAVAILABLE");
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0 || value > 1_000_000)
        throw new Error("FX_UNAVAILABLE");
      rates[currency] = value;
    }
    this.cached = { rates, fetchedAt: this.now() };
  }
}

export function registerFxRoutes(
  app: FastifyInstance,
  rates = new MarketRates()
) {
  app.get("/fx/quote", async (request, reply) => {
    const currency = (request.query as { currency?: string }).currency;
    if (typeof currency !== "string" || !CURRENCIES.has(currency))
      return reply.code(400).send({ error: "UNSUPPORTED_CURRENCY" });
    try {
      reply.header("Cache-Control", "no-store");
      return await rates.quote(currency);
    } catch {
      return reply.code(503).send({ error: "FX_UNAVAILABLE" });
    }
  });
}
