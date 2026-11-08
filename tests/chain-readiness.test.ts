import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { buildApp } from "../server/src/app.ts";
import { openDatabase } from "../server/src/db.ts";
import { encodeBase58 } from "../server/src/bytes.ts";
import {
  checkedAccount,
  type ChainSnapshot,
} from "../server/src/chain-readiness.ts";
import { CROSS_BORDER_ROUTES } from "../src/leash/corridors.ts";
import { DEVNET_RPC, PROGRAM_ID } from "../src/leash/deployment.ts";
import { paymentSetupIssue } from "../src/leash/readiness.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function setup() {
  const policy = nacl.sign.keyPair();
  const verifier = nacl.sign.keyPair().publicKey;
  const mint = encodeBase58(nacl.sign.keyPair().publicKey);
  const snapshot: ChainSnapshot = {
    cluster: "devnet",
    rpc: DEVNET_RPC,
    program: PROGRAM_ID,
    programDeployed: true,
    configAddress: PROGRAM_ID,
    config: {
      admin: PROGRAM_ID,
      policySigner: encodeBase58(policy.publicKey),
      verifier: encodeBase58(verifier),
      mint,
      policyVersion: 1,
      requiredChecks: 4095,
    },
    routes: CROSS_BORDER_ROUTES.map(({ id }) => ({
      id,
      address: PROGRAM_ID,
      status: "ready",
      perPaymentCap: "1000000",
      dailyCap: "10000000000",
      packetThreshold: "0",
    })),
  };
  const db = openDatabase(":memory:");
  let unavailable = false;
  const app = buildApp({
    db,
    policy,
    verifier,
    mint,
    policyVersion: 1,
    readChainSnapshot: async () => {
      if (unavailable) throw new Error("RPC timed out");
      return snapshot;
    },
  });
  cleanup.push(async () => {
    await app.close();
    db.close();
  });
  return {
    app,
    snapshot,
    failRpc: () => {
      unavailable = true;
    },
  };
}

describe("backend / frontend / devnet readiness", () => {
  it("does not mistake a seeded database route for an on-chain route", async () => {
    const { app, snapshot } = setup();
    snapshot.routes[0].status = "missing";
    const result = (await app.inject("/health/chain")).json();
    expect((await app.inject("/health")).json().ok).toBe(true);
    expect(result.configurationReady).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.routes[0]).toMatchObject({
      gateEnabled: true,
      status: "missing",
      ready: false,
    });
    expect(paymentSetupIssue(result, "US-IN")?.title).toBe(
      "Route setup required"
    );
    expect(paymentSetupIssue(result, "US-GB")).toBeNull();
    snapshot.routes[0].status = "ready";
    expect((await app.inject("/health/chain")).json().ready).toBe(true);
  });

  it.each([
    "mint",
    "policySigner",
    "verifier",
    "policyVersion",
    "requiredChecks",
  ] as const)("blocks a backend / chain %s mismatch", async (key) => {
    const { app, snapshot } = setup();
    const config = snapshot.config!;
    if (key === "policyVersion" || key === "requiredChecks") config[key] += 1;
    else config[key] = PROGRAM_ID;
    const result = (await app.inject("/health/chain")).json();
    expect(result.configurationReady).toBe(false);
    expect(result.mismatches).toContain(key);
    expect(paymentSetupIssue(result, "US-IN")?.title).toBe(
      "Configuration mismatch"
    );
  });

  it("reports RPC failure separately from a missing route", async () => {
    const { app, failRpc } = setup();
    failRpc();
    const response = await app.inject("/health/chain");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "CHAIN_CHECK_UNAVAILABLE",
      ready: false,
    });
  });

  it("reports a disabled chain route and inconsistent backend limits", async () => {
    const { app, snapshot } = setup();
    snapshot.routes[0].status = "disabled";
    let result = (await app.inject("/health/chain")).json();
    expect(paymentSetupIssue(result, "US-IN")?.title).toBe("Route unavailable");
    snapshot.routes[0].status = "ready";
    snapshot.routes[0].perPaymentCap = "500000";
    result = (await app.inject("/health/chain")).json();
    expect(result.routes[0]).toMatchObject({
      limitsMatch: false,
      ready: false,
    });
    expect(paymentSetupIssue(result, "US-IN")?.title).toBe(
      "Route configuration mismatch"
    );
  });

  it("validates account owner, size and discriminator before decoding", () => {
    const data = Buffer.alloc(54);
    createHash("sha256")
      .update("account:Corridor")
      .digest()
      .copy(data, 0, 0, 8);
    const account = {
      owner: PROGRAM_ID,
      executable: false,
      data: [data.toString("base64"), "base64"] as const,
    };
    expect(checkedAccount(account, "Corridor", 54)).toEqual(data);
    expect(
      checkedAccount(
        { ...account, owner: "11111111111111111111111111111111" },
        "Corridor",
        54
      )
    ).toBeNull();
    expect(checkedAccount(account, "Config", 54)).toBeNull();
    expect(checkedAccount(account, "Corridor", 53)).toBeNull();
  });
});
