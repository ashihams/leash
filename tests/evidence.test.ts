import { describe, expect, it } from "vitest";
import { bannerFrom, mandateRecovery } from "../src/leash/evidence.ts";

describe("mandate evidence", () => {
  const denied = {
    title: "North Studio · Deny",
    detail: "MANDATE_REVOKED, BUDGET",
  };
  const opened = {
    title: "Mandate registered",
    detail: "Mandate 37 is registered in the gate.",
  };

  it("does not carry a previous mandate's refusal into a new setup", () => {
    expect(
      bannerFrom([
        { title: "Deposit", detail: "Deposited test USDC into the treasury." },
        { title: "Mandate account", detail: "Created mandate 37 on devnet." },
        opened,
        denied,
      ])
    ).toBeNull();
  });

  it("keeps a denial when selecting the same mandate again", () => {
    expect(
      bannerFrom([{ title: "Mandate selected", detail: "Mandate 36." }, denied])
        ?.tone
    ).toBe("refused");
  });

  it("shows a new decision after registering the next mandate", () => {
    expect(
      bannerFrom([
        { title: "North Studio · Allow", detail: "The gate signed an allow." },
        opened,
        denied,
      ])?.tone
    ).toBe("cleared");
    expect(bannerFrom([denied, opened])?.tone).toBe("refused");
  });

  it("prioritizes revocation over the budget failure", () => {
    expect(mandateRecovery(["MANDATE_REVOKED", "BUDGET"])).toContain("revoked");
    expect(mandateRecovery(["BUDGET"])).toContain("remaining budget");
    expect(mandateRecovery(["PAYMENT_LIMIT"])).toBeNull();
  });
});
