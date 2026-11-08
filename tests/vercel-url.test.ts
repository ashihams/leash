import { describe, expect, it } from "vitest";
import { gateRequestUrl } from "../server/src/vercel-url.ts";

describe("Vercel gate routing", () => {
  it("preserves the currency query needed by the frontend", () => {
    expect(
      gateRequestUrl("/api/gate/fx/quote?currency=INR", ["fx", "quote"])
    ).toBe("/fx/quote?currency=INR");
  });
  it("supports string catch-all parameters and URL fallback", () => {
    expect(gateRequestUrl("/api/gate/health/chain", "health/chain")).toBe(
      "/health/chain"
    );
    expect(gateRequestUrl("/api/gate/fx/quote?currency=GBP", undefined)).toBe(
      "/fx/quote?currency=GBP"
    );
  });
  it("routes rewritten nested requests without leaking the internal routing parameter", () => {
    expect(
      gateRequestUrl("/api/gate?__gatePath=fx%2Fquote&currency=INR", "fx/quote")
    ).toBe("/fx/quote?currency=INR");
    expect(
      gateRequestUrl("/api/gate?__gatePath=health%2Fchain", "health/chain")
    ).toBe("/health/chain");
  });
});
