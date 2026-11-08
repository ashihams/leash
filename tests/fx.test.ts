import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { MarketRates, registerFxRoutes } from "../server/src/fx.ts";
import {
  CROSS_BORDER_ROUTES,
  formatLocalAmount,
  type FxQuote,
} from "../src/leash/corridors.ts";

const raw = {
  data: {
    currency: "USDC",
    rates: {
      USD: "0.9998",
      INR: "84.75",
      GBP: "0.78",
      EUR: "0.92",
      PHP: "58.25",
    },
  },
};
describe("market conversion quotes", () => {
  it("uses current USDC rates, shares the cache across routes, and expires it after one minute", async () => {
    let now = Date.UTC(2026, 10, 8);
    let calls = 0;
    const rates = new MarketRates(
      (async (url) => {
        expect(String(url)).toContain("currency=USDC");
        calls++;
        return Response.json(raw);
      }) as typeof fetch,
      () => now
    );
    const inr = await rates.quote("INR");
    expect(inr.rate).toBe(84.75);
    expect(inr.usdRate).toBe(0.9998);
    expect(Date.parse(inr.expiresAt) - Date.parse(inr.fetchedAt)).toBe(60_000);
    expect((await rates.quote("GBP")).rate).toBe(0.78);
    expect(calls).toBe(1);
    now += 60_000;
    await rates.quote("INR");
    expect(calls).toBe(2);
    expect(formatLocalAmount(2, inr)).toContain("169.50");
  });

  it("does not serve an expired cached quote during an upstream outage", async () => {
    let now = 0;
    let down = false;
    const rates = new MarketRates(
      (async () =>
        down
          ? new Response("", { status: 503 })
          : Response.json(raw)) as typeof fetch,
      () => now
    );
    await rates.quote("INR");
    now = 60_001;
    down = true;
    await expect(rates.quote("INR")).rejects.toThrow("FX_UNAVAILABLE");
    down = false;
    expect((await rates.quote("INR")).rate).toBe(84.75);
  });

  it("rejects invalid market data and unsupported currencies through the API", async () => {
    for (const bad of ["0", "-10", "Infinity", "84.5junk", null]) {
      const rates = new MarketRates((async () =>
        Response.json({
          data: { ...raw.data, rates: { ...raw.data.rates, INR: bad } },
        })) as typeof fetch);
      const app = Fastify();
      registerFxRoutes(app, rates);
      expect(
        (await app.inject({ url: "/fx/quote?currency=INR" })).statusCode
      ).toBe(503);
      expect(
        (await app.inject({ url: "/fx/quote?currency=ZZZ" })).statusCode
      ).toBe(400);
      await app.close();
    }
    expect(
      CROSS_BORDER_ROUTES.every(
        (route) => route.fromCountry !== String(route.toCountry)
      )
    ).toBe(true);
    expect(
      formatLocalAmount(NaN, { currency: "INR", rate: 84 } as FxQuote)
    ).toBe("—");
  });
});
