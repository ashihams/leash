import nacl from "tweetnacl";
import type { LogLine } from "./evidence.ts";

// Clearance v1: vendor occupies bytes 100..131 of the 288-byte signed message.
export function testVendorTampering(
  message: Uint8Array,
  signature: Uint8Array,
  signer: Uint8Array,
  vendors: readonly Uint8Array[]
): LogLine {
  if (
    message.length !== 288 ||
    signature.length !== 64 ||
    signer.length !== 32
  ) {
    return {
      title: "Vendor test unavailable",
      detail:
        "The saved clearance is malformed. Request a new clearance before testing.",
      testOutcome: "unavailable",
    };
  }
  if (!nacl.sign.detached.verify(message, signature, signer)) {
    return {
      title: "Vendor test unavailable",
      detail:
        "The original clearance signature is invalid, so this test cannot verify vendor protection.",
      testOutcome: "unavailable",
    };
  }
  const originalVendor = message.subarray(100, 132);
  const other = vendors.find(
    (candidate) =>
      candidate.length === 32 &&
      candidate.some((byte, index) => byte !== originalVendor[index])
  );
  if (!other) {
    return {
      title: "Vendor test unavailable",
      detail: "A different vendor is needed to test this clearance.",
      testOutcome: "unavailable",
    };
  }
  const swapped = message.slice();
  swapped.set(other, 100);
  if (nacl.sign.detached.verify(swapped, signature, signer)) {
    return {
      title: "Vendor protection failed",
      detail:
        "The changed vendor unexpectedly passed signature verification. Do not use this clearance.",
      testOutcome: "fail",
    };
  }
  return {
    title: "Vendor protection passed",
    detail:
      "The original signature is valid. Changing the vendor invalidates it, as expected. This was a local signature check; no transaction was submitted. To pay another vendor, select them and request a new clearance.",
    testOutcome: "pass",
  };
}
