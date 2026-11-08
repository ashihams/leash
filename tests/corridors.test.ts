import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { encodeBase58, decodeBase58 } from "../server/src/bytes.ts";
import { intentMessage } from "../server/src/intent.ts";
import { signIntent, hexToBytes, base64ToBytes } from "../src/leash/client.ts";
import {
  corridorPda,
  createMandateInstruction,
  fundInstructions,
} from "../src/leash/chain.ts";

describe("cross-border authorization", () => {
  it("binds the signed intent to US-IN and rejects a changed destination", () => {
    const agent = nacl.sign.keyPair();
    const fields = {
      kind: 1,
      paymentId: "11".repeat(32),
      mandate: encodeBase58(nacl.sign.keyPair().publicKey),
      buyer: encodeBase58(nacl.sign.keyPair().publicKey),
      vendor: encodeBase58(nacl.sign.keyPair().publicKey),
      mint: encodeBase58(nacl.sign.keyPair().publicKey),
      amount: 1_000_000,
      invoiceHash: "22".repeat(32),
      fromCountry: "US",
      toCountry: "IN",
    };
    const signature = base64ToBytes(signIntent(agent.secretKey, fields));
    const intent = {
      ...fields,
      paymentId: hexToBytes(fields.paymentId),
      mandate: decodeBase58(fields.mandate),
      buyer: decodeBase58(fields.buyer),
      vendor: decodeBase58(fields.vendor),
      mint: decodeBase58(fields.mint),
      invoiceHash: hexToBytes(fields.invoiceHash),
      invoiceAmount: fields.amount,
      category: 7,
      purposeCode: 1001,
    };
    expect(
      nacl.sign.detached.verify(
        intentMessage(intent),
        signature,
        agent.publicKey
      )
    ).toBe(true);
    expect(
      nacl.sign.detached.verify(
        intentMessage({ ...intent, toCountry: "GB" }),
        signature,
        agent.publicKey
      )
    ).toBe(false);
  });

  it("encodes all four allowed routes in the mandate and uses the selected corridor PDA for funding", async () => {
    const key = () => encodeBase58(nacl.sign.keyPair().publicKey);
    const owner = key(),
      mandate = key(),
      agent = key(),
      mint = key();
    const instruction = await createMandateInstruction({
      owner,
      mandate,
      mandateId: 1,
      agent,
      mint,
      budget: 2_000_000,
      perPayment: 1_000_000,
      expiresAt: 1800000000,
    });
    const bytes = Buffer.from(instruction.data!);
    expect(bytes.readUInt32LE(94)).toBe(4);
    expect(bytes.subarray(98).toString()).toBe("USINUSGBUSDEUSPH");
    const instructions = await fundInstructions({
      agent,
      owner,
      mandate,
      mandateId: 1,
      mint,
      vendor: key(),
      paymentId: new Uint8Array(32),
      ed25519: new Uint8Array(),
      route: { fromCountry: "US", toCountry: "IN" },
    });
    expect(instructions[1].accounts?.[4].address).toBe(
      await corridorPda("US", "IN")
    );
    expect(Buffer.from(instructions[1].data!).subarray(-4).toString()).toBe(
      "USIN"
    );
    expect(await corridorPda("US", "IN")).not.toBe(
      await corridorPda("US", "GB")
    );
  });
});
