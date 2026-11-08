import { afterEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { testVendorTampering } from "../src/leash/vendor-tampering.ts";
import { bannerFrom, markFor } from "../src/leash/evidence.ts";
import { CLEARANCE_LEN } from "../server/src/clearance.ts";

function clearance() {
  const signer = nacl.sign.keyPair();
  const vendor = nacl.sign.keyPair().publicKey;
  const other = nacl.sign.keyPair().publicKey;
  const message = new Uint8Array(CLEARANCE_LEN);
  message[0] = 1;
  message.set(vendor, 100);
  const signature = nacl.sign.detached(message, signer.secretKey);
  return { message, signature, signer: signer.publicKey, vendor, other };
}

afterEach(() => vi.restoreAllMocks());

describe("vendor tampering test", () => {
  it("marks expected signature rejection as protection passed and preserves the clearance", () => {
    const c = clearance();
    const original = c.message.slice();
    const result = testVendorTampering(c.message, c.signature, c.signer, [
      c.vendor,
      c.other,
    ]);
    expect(result.testOutcome).toBe("pass");
    expect(result.signature).toBeUndefined();
    expect(markFor(result)).toBe("pass");
    expect(
      bannerFrom([
        result,
        { title: "North Studio · Allow", detail: "Approved" },
      ])?.title
    ).toBe("Protection passed");
    expect(c.message).toEqual(original);
    expect(nacl.sign.detached.verify(c.message, c.signature, c.signer)).toBe(
      true
    );
  });

  it("changes the signed vendor even when the UI vendor order changes", () => {
    const c = clearance();
    expect(
      testVendorTampering(c.message, c.signature, c.signer, [c.other, c.vendor])
        .testOutcome
    ).toBe("pass");
  });

  it("does not report protection passed for an invalid original signature", () => {
    const c = clearance();
    c.signature[0] ^= 1;
    const result = testVendorTampering(c.message, c.signature, c.signer, [
      c.other,
    ]);
    expect(result.testOutcome).toBe("unavailable");
    expect(markFor(result)).toBe("flag");
    expect(bannerFrom([result])?.title).toBe("Test unavailable");
  });

  it("requires a valid message and a genuinely different vendor", () => {
    const c = clearance();
    expect(
      testVendorTampering(c.message.subarray(0, 120), c.signature, c.signer, [
        c.other,
      ]).testOutcome
    ).toBe("unavailable");
    expect(
      testVendorTampering(c.message, c.signature, c.signer, [c.vendor])
        .testOutcome
    ).toBe("unavailable");
  });

  it("reports an unexpected acceptance as a failed protection test", () => {
    const c = clearance();
    vi.spyOn(nacl.sign.detached, "verify").mockReturnValue(true);
    const result = testVendorTampering(c.message, c.signature, c.signer, [
      c.other,
    ]);
    expect(result.testOutcome).toBe("fail");
    expect(markFor(result)).toBe("fail");
    expect(bannerFrom([result])?.title).toBe("Protection test failed");
  });

  it("keeps later payment denials and new mandate boundaries authoritative", () => {
    const c = clearance();
    const passed = testVendorTampering(c.message, c.signature, c.signer, [
      c.other,
    ]);
    expect(
      bannerFrom([{ title: "North Studio · Deny", detail: "BUDGET" }, passed])
        ?.title
    ).toBe("Refused");
    expect(
      bannerFrom([
        { title: "Mandate registered", detail: "New mandate" },
        passed,
      ])
    ).toBeNull();
  });
});
