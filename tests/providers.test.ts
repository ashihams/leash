import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { buildApp } from "../server/src/app.ts";
import { decodeBase58, encodeBase58 } from "../server/src/bytes.ts";
import { intentMessage } from "../server/src/clearance.ts";
import { openDatabase, upsertIdentity } from "../server/src/db.ts";
import { assertProviderConfig } from "../server/src/providers/config.ts";
import {
  downloadOfacSnapshot,
  OfacScreenError,
  OfacSdnProvider,
  ofacNoMatchStatement,
  parseOfacAdvancedXml,
  versionsToDrop,
  type OfacSnapshot,
} from "../server/src/providers/ofac.ts";
import {
  interpretRange,
  RangeSanctions,
} from "../server/src/providers/range.ts";
import {
  DiditIdentity,
  identityCheck,
} from "../server/src/providers/identity.ts";

const NOW = 1_700_000_000;
const PAYMENT = 100_000_000;
const SECRET = "didit-test-secret";
const SOLANA = "So11111111111111111111111111111111111111112";

describe("OFAC SDN screener", () => {
  it("extracts every digital currency symbol and lowercases EVM addresses", async () => {
    const rows = await parseOfacAdvancedXml(
      sdnXml([
        { symbol: "SOL", address: SOLANA, entryId: "10", program: "SDGT" },
        {
          symbol: "ETH",
          address: "0xAbCdEf0000000000000000000000000000000001",
          entryId: "10",
          program: "SDGT",
        },
        {
          symbol: "XBT",
          address: "bc1qExampleAddress",
          entryId: "11",
          program: "CYBER2",
        },
      ])
    );
    expect(rows.map((row) => row.currencySymbol).sort()).toEqual([
      "ETH",
      "SOL",
      "XBT",
    ]);
    expect(rows.find((row) => row.currencySymbol === "ETH")?.address).toBe(
      "0xabcdef0000000000000000000000000000000001"
    );
    expect(rows.find((row) => row.currencySymbol === "SOL")).toMatchObject({
      address: SOLANA,
      sdnEntryId: "10",
      programs: ["SDGT"],
    });
    expect(rows.find((row) => row.currencySymbol === "XBT")?.address).toBe(
      "bc1qExampleAddress"
    );
  });

  it("fails a listed Solana address and passes an unlisted one", async () => {
    const provider = new OfacSdnProvider(() => NOW * 1000);
    provider.load(snapshot([SOLANA]));
    const listed = await provider.screenWallet(SOLANA);
    const clean = await provider.screenWallet(otherSolana());
    expect(listed.listed).toBe(true);
    expect(listed.raw).toMatchObject({
      sdn_entry_id: "10",
      currency: "SOL",
      sha256: "abc",
    });
    expect(clean.listed).toBe(false);
    expect(clean.raw).toMatchObject({
      source: "OFAC SDN",
      statement: ofacNoMatchStatement(
        new Date(NOW * 1000).toISOString(),
        "abc"
      ),
    });
  });

  it("rejects an invalid address, an empty list, a stale list, and a hash mismatch", async () => {
    const provider = new OfacSdnProvider(() => NOW * 1000);
    await expect(
      provider.screenWallet("not-a-solana-address")
    ).rejects.toMatchObject({
      code: "PARAMS_INVALID",
    });
    await expect(
      provider.screenWallet(`0x${"ab".repeat(20)}`)
    ).rejects.toMatchObject({
      code: "PARAMS_INVALID",
    });
    expect(() =>
      provider.load({
        ...snapshot([SOLANA]),
        addresses: [],
        addressCount: 0,
        solAddressCount: 0,
      })
    ).toThrow(OfacScreenError);
    const stale = new OfacSdnProvider(() => NOW * 1000);
    stale.load(
      snapshot(
        [SOLANA],
        new Date(NOW * 1000 - 73 * 60 * 60 * 1000).toISOString()
      )
    );
    await expect(stale.screenWallet(SOLANA)).rejects.toMatchObject({
      code: "LIST_STALE",
    });
    const xml = sdnXml([
      { symbol: "SOL", address: SOLANA, entryId: "10", program: "SDGT" },
    ]);
    await expect(
      downloadOfacSnapshot({
        fetchImpl: async () =>
          new Response(xml, {
            status: 200,
            headers: { digest: `sha-256${"ab".repeat(32)}` },
          }),
        retrievedAt: new Date(NOW * 1000).toISOString(),
      })
    ).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    await expect(
      downloadOfacSnapshot({
        fetchImpl: async () => new Response(sdnXml([]), { status: 200 }),
        retrievedAt: new Date(NOW * 1000).toISOString(),
      })
    ).rejects.toMatchObject({ code: "EMPTY_LIST" });
    expect(versionsToDrop(["4", "3", "2", "1"])).toEqual(["1"]);
  });
});

describe("identity status mapping", () => {
  const nowMs = NOW * 1000;
  it("maps each documented session status", () => {
    expect(identityCheck({ record: null, nowMs })).toEqual({
      status: "fail",
      reasonCode: "VENDOR_NOT_REGISTERED",
    });
    expect(
      identityCheck({ record: { status: "Approved", expiresAt: null }, nowMs })
    ).toEqual({ status: "pass", reasonCode: "" });
    expect(
      identityCheck({ record: { status: "In Review", expiresAt: null }, nowMs })
    ).toEqual({ status: "flag", reasonCode: "REVIEW_STARTED" });
    expect(
      identityCheck({ record: { status: "Declined", expiresAt: null }, nowMs })
    ).toEqual({ status: "fail", reasonCode: "VENDOR_CREDENTIAL_INVALID" });
    expect(
      identityCheck({
        record: { status: "Kyc Expired", expiresAt: null },
        nowMs,
      })
    ).toEqual({ status: "fail", reasonCode: "VENDOR_CREDENTIAL_EXPIRED" });
    expect(
      identityCheck({
        record: { status: "Approved", expiresAt: "2000-01-01T00:00:00.000Z" },
        nowMs,
      })
    ).toEqual({ status: "fail", reasonCode: "VENDOR_CREDENTIAL_EXPIRED" });
    expect(
      identityCheck({
        record: { status: "Not Started", expiresAt: null },
        nowMs,
      })
    ).toEqual({ status: "flag", reasonCode: "SESSION_OPEN" });
  });
});

describe("provider gate over HTTP", () => {
  it("fails closed without OFAC and does not require Didit for mock vendors", async () => {
    const missing = await fundWith({ noProviders: true });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().error).toBe("CHECK_UNAVAILABLE");
    for (const options of [
      { diditUnavailable: true },
      { wrongWallet: true },
      { liveStatus: "Declined" },
    ]) {
      const result = await fundWith(options);
      expect(result.statusCode).toBe(200);
      expect(result.json().decision).toBe("allow");
    }
  });

  it("does not include Didit results in vendor clearance evidence", async () => {
    const result = await fundWith({
      identityStatus: "Approved",
      liveStatus: "Declined",
    });
    expect(result.json().decision).toBe("allow");
    const evidence = await result.world.app.inject({
      method: "GET",
      url: `/evidence/${result.world.paymentId}`,
    });
    expect(
      evidence
        .json()
        .providerChecks.some(
          (check: { provider: string }) => check.provider === "didit"
        )
    ).toBe(false);
  });

  it("keeps the vendor result independent of Didit status", async () => {
    const result = await fundWith({
      identityStatus: "Approved",
      liveStatus: "Declined",
    });
    expect(result.json().decision).toBe("allow");
  });

  it("denies a listed wallet, records a clean OFAC result, and denies when the list is unavailable", async () => {
    const listed = await fundWith({ screening: "listed" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().decision).toBe("deny");
    expect(listed.json().reasons).toContain("LIST_MATCH_WALLET");
    const listedEvidence = await listed.world.app.inject({
      method: "GET",
      url: `/evidence/${listed.world.paymentId}`,
    });
    expect(listedEvidence.json().notes[0]).toContain("sdn_entry_id 10");
    expect(listedEvidence.json().providerChecks[0]).toMatchObject({
      provider: "ofac",
      status: "fail",
      reasonCode: "LIST_MATCH_WALLET",
    });

    const clean = await fundWith({ screening: "clean" });
    expect(clean.json().decision).toBe("allow");
    const evidence = await clean.world.app.inject({
      method: "GET",
      url: `/evidence/${clean.world.paymentId}`,
    });
    expect(evidence.json().notes[0]).toContain(
      "No match on the OFAC SDN list (US Treasury), retrieved"
    );
    expect(evidence.json().notes[0]).toContain(
      "OFAC states its digital currency address listings are not exhaustive. EU, UN and other lists are not covered."
    );

    const flagged = await fundWith({
      screening: "clean",
      identityStatus: "In Review",
    });
    expect(flagged.json().decision).toBe("allow");

    const stale = await fundWith({ screening: "stale" });
    expect(stale.statusCode).toBe(503);
    expect(stale.json().error).toBe("CHECK_UNAVAILABLE");
    expect(stale.json().reason).toBe("LIST_STALE");
    expect(stale.json().decision).toBeUndefined();

    const down = await fundWith({ screening: "empty" });
    expect(down.statusCode).toBe(503);
    expect(down.json().error).toBe("CHECK_UNAVAILABLE");
    expect(down.json().decision).toBeUndefined();
  });
});

describe("didit webhooks", () => {
  it("rejects a validly signed webhook for a different stored session", async () => {
    const world = webhookApp();
    const wallet = otherSolana();
    upsertIdentity(world.db, {
      vendorWallet: wallet,
      provider: "didit",
      sessionId: "registered-session",
      status: "Not Started",
      expiresAt: null,
      updatedAt: new Date(NOW * 1000).toISOString(),
    });
    const body = bodyOf("wrong-session", wallet, "Approved");
    const response = await world.inject(body, signedHeaders(body, SECRET));
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("SESSION_MISMATCH");
  });
  it("rejects unsigned, invalid, modified, replayed, and stale events", async () => {
    const world = webhookApp();
    const wallet = encodeBase58(nacl.sign.keyPair().publicKey);
    const unsigned = await world.inject(
      bodyOf("evt-unsigned", wallet, "Approved"),
      {}
    );
    expect(unsigned.statusCode).toBe(401);

    const invalid = await world.inject(
      bodyOf("evt-bad", wallet, "Approved"),
      signedHeaders(bodyOf("evt-bad", wallet, "Approved"), "wrong-secret")
    );
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error).toBe("SIGNATURE_INVALID");

    const original = bodyOf("evt-mod", wallet, "Approved");
    const modified = Buffer.from(original);
    modified[modified.length - 2] =
      modified[modified.length - 2] === 65 ? 66 : 65;
    const changed = await world.inject(
      modified,
      signedHeaders(original, SECRET)
    );
    expect(changed.statusCode).toBe(401);

    const staleBody = bodyOf("evt-stale", wallet, "Approved");
    const stale = await world.inject(staleBody, {
      ...signedHeaders(staleBody, SECRET),
      "x-timestamp": String(NOW - 301),
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error).toBe("STALE");

    const replay = bodyOf("evt-replay", wallet, "Approved");
    const first = await world.inject(replay, signedHeaders(replay, SECRET));
    const second = await world.inject(replay, signedHeaders(replay, SECRET));
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect(second.json().error).toBe("REPLAYED");
    const again = bodyOf("evt-same-session", wallet, "Approved");
    const repeated = await world.inject(again, signedHeaders(again, SECRET));
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().idempotent).toBe(true);
    const stored = world.db
      .prepare(
        "select status from identity_verifications where vendor_wallet = ?"
      )
      .get(wallet) as { status: string };
    expect(stored.status).toBe("Approved");
    const audit = world.db
      .prepare("select details from audit_log")
      .all() as Array<{ details: string }>;
    expect(audit.some((row) => row.details.includes("Should Not Store"))).toBe(
      false
    );
  });

  it("stores each terminal status without provider personal data", async () => {
    for (const status of ["Approved", "In Review", "Declined", "Kyc Expired"]) {
      const world = webhookApp();
      const wallet = encodeBase58(nacl.sign.keyPair().publicKey);
      const raw = bodyOf(`evt-${status}`, wallet, status);
      const response = await world.inject(raw, signedHeaders(raw, SECRET));
      expect(response.statusCode).toBe(200);
      const row = world.db
        .prepare(
          "select status, vendor_wallet, session_id, expires_at from identity_verifications"
        )
        .get() as {
        status: string;
        vendor_wallet: string;
        session_id: string;
        expires_at: string | null;
      };
      expect(row).toMatchObject({
        status,
        vendor_wallet: wallet,
        session_id: `sess-${status}`,
      });
      expect(JSON.stringify(row)).not.toContain("Should Not Store");
    }
  });
});

describe("startup and vendor verification route", () => {
  it("refuses missing provider config", () => {
    try {
      assertProviderConfig({});
      throw new Error("started");
    } catch (error) {
      const missing = (error as { missing?: string[] }).missing ?? [];
      expect(missing).toEqual([
        "DIDIT_API_KEY",
        "DIDIT_WORKFLOW_ID",
        "DIDIT_WEBHOOK_SECRET",
      ]);
    }
    const child = spawnSync(process.execPath, ["server/src/index.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        LEASH_USDC_MINT: "mint",
        DIDIT_API_KEY: "",
        DIDIT_WORKFLOW_ID: "",
        DIDIT_WEBHOOK_SECRET: "",
      },
    });
    expect(child.status).toBe(1);
    expect(`${child.stdout}${child.stderr}`).toContain("Refusing to start");
    expect(`${child.stdout}${child.stderr}`).not.toContain(SECRET);
  });

  it("does not expose the vendor Didit route", async () => {
    const db = openDatabase(":memory:");
    const identity = new DiditIdentity(
      "key",
      "11111111-1111-1111-1111-111111111111",
      SECRET
    );
    const sanctions = new OfacSdnProvider();
    const app = buildApp({
      db,
      policy: nacl.sign.keyPair(),
      verifier: nacl.sign.keyPair().publicKey,
      mint: encodeBase58(nacl.sign.keyPair().publicKey),
      policyVersion: 1,
      now: () => NOW,
      providerRoutes: {
        db,
        sanctions,
        identity,
        environment: "sandbox",
      },
    });
    const wallet = encodeBase58(nacl.sign.keyPair().publicKey);
    const denied = await app.inject({
      method: "POST",
      url: `/vendors/${wallet}/verification`,
    });
    expect(denied.statusCode).toBe(404);
  });
});

function otherSolana(): string {
  return encodeBase58(nacl.sign.keyPair().publicKey);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fundWith(
  options: {
    noProviders?: boolean;
    liveStatus?: string;
    diditUnavailable?: boolean;
    wrongWallet?: boolean;
    identityStatus?: string;
    screening?: "clean" | "listed" | "stale" | "empty";
    enqueue?: (entry: {
      paymentId: string;
      wallet: string;
      reasonCode: string;
    }) => Promise<void>;
  } = {}
) {
  const policy = nacl.sign.keyPair();
  const owner = nacl.sign.keyPair();
  const agent = nacl.sign.keyPair();
  const vendor = nacl.sign.keyPair();
  const mint = nacl.sign.keyPair().publicKey;
  const mandate = nacl.sign.keyPair().publicKey;
  const db = openDatabase(":memory:");
  const vendorWallet = encodeBase58(vendor.publicKey);
  upsertIdentity(db, {
    vendorWallet,
    provider: "didit",
    sessionId: "sess-fund",
    status: options.identityStatus ?? "Approved",
    expiresAt: null,
    updatedAt: new Date(NOW * 1000).toISOString(),
  });
  const sanctions = new OfacSdnProvider(() => NOW * 1000);
  const screening = options.screening ?? "clean";
  if (
    screening === "listed" ||
    screening === "clean" ||
    screening === "stale"
  ) {
    const listed = screening === "clean" ? otherSolana() : vendorWallet;
    const retrievedAt =
      screening === "stale"
        ? new Date(NOW * 1000 - 73 * 60 * 60 * 1000).toISOString()
        : new Date(NOW * 1000).toISOString();
    sanctions.load(snapshot([listed], retrievedAt));
  }
  let liveStatus = options.liveStatus ?? options.identityStatus ?? "Approved";
  const identity = new DiditIdentity("key", "workflow", SECRET, (async () =>
    json(options.diditUnavailable ? 503 : 200, {
      session_id: "sess-fund",
      vendor_data: options.wrongWallet ? otherSolana() : vendorWallet,
      workflow_id: "workflow",
      status: liveStatus,
    })) as typeof fetch);
  const app = buildApp({
    db,
    policy,
    verifier: nacl.sign.keyPair().publicKey,
    mint: encodeBase58(mint),
    policyVersion: 1,
    now: () => NOW,
    providerRoutes: options.noProviders
      ? undefined
      : {
          db,
          sanctions,
          identity,
          environment: "live",
          enqueueReview: options.enqueue,
        },
  });
  const buyer = encodeBase58(owner.publicKey);
  const mandateAccount = encodeBase58(mandate);
  await app.inject({
    method: "POST",
    url: "/vendors",
    payload: { wallet: vendorWallet, name: "North Studio", country: "US" },
  });
  await app.inject({
    method: "POST",
    url: "/corridors",
    payload: {
      fromCountry: "US",
      toCountry: "US",
      enabled: true,
      perPaymentCap: 150_000_000,
      dailyCap: 1_000_000_000,
      packetThreshold: 0,
    },
  });
  await app.inject({
    method: "POST",
    url: "/mandates",
    payload: {
      mandateId: 7,
      mandate: mandateAccount,
      owner: buyer,
      agent: encodeBase58(agent.publicKey),
      budget: 200_000_000,
      perPaymentLimit: 150_000_000,
      maxUses: 4,
      expiresAt: NOW + 86_400,
      deliverySeconds: 3600,
      acceptanceSeconds: 3600,
      category: 7,
      corridors: [{ fromCountry: "US", toCountry: "US" }],
    },
  });
  const paymentId = "11".repeat(32);
  const payload = {
    paymentId,
    mandateId: 7,
    mandate: mandateAccount,
    buyer,
    vendor: vendorWallet,
    mint: encodeBase58(mint),
    amount: PAYMENT,
    fromCountry: "US",
    toCountry: "US",
    category: 7,
    purposeCode: 1001,
    invoiceHash: "aa".repeat(32),
    invoiceCurrency: "USD",
    invoiceAmount: PAYMENT,
  };
  const message = intentMessage({
    kind: 1,
    paymentId: Buffer.from(paymentId, "hex"),
    mandate,
    buyer: owner.publicKey,
    vendor: decodeBase58(vendorWallet),
    mint,
    amount: PAYMENT,
    fromCountry: "US",
    toCountry: "US",
    category: 7,
    purposeCode: 1001,
    invoiceHash: Buffer.from("aa".repeat(32), "hex"),
    invoiceAmount: PAYMENT,
  });
  const response = await app.inject({
    method: "POST",
    url: "/clearances/fund",
    payload: {
      ...payload,
      intentSignature: Buffer.from(
        nacl.sign.detached(message, agent.secretKey)
      ).toString("base64"),
    },
  });
  return {
    statusCode: response.statusCode,
    json: () => response.json(),
    world: {
      app,
      paymentId,
      setLiveStatus(status: string) {
        liveStatus = status;
      },
    },
  };
}

function webhookApp() {
  const db = openDatabase(":memory:");
  const identity = new DiditIdentity("key", "workflow", SECRET);
  const sanctions = new OfacSdnProvider();
  const app = buildApp({
    db,
    policy: nacl.sign.keyPair(),
    verifier: nacl.sign.keyPair().publicKey,
    mint: encodeBase58(nacl.sign.keyPair().publicKey),
    policyVersion: 1,
    now: () => NOW,
    providerRoutes: {
      db,
      sanctions,
      identity,
      environment: "sandbox",
      now: () => NOW,
    },
  });
  return {
    db,
    inject(payload: Buffer, headers: Record<string, string>) {
      let fixture: { vendor_data: string; session_id: string } | undefined;
      try {
        fixture = JSON.parse(payload.toString());
      } catch {
        /* Deliberately malformed webhook fixture. */
      }
      if (
        fixture &&
        !db
          .prepare(
            "select 1 from identity_verifications where vendor_wallet = ?"
          )
          .get(fixture.vendor_data)
      ) {
        upsertIdentity(db, {
          vendorWallet: fixture.vendor_data,
          provider: "didit",
          sessionId: fixture.session_id,
          status: "Not Started",
          expiresAt: null,
          updatedAt: new Date(NOW * 1000).toISOString(),
        });
      }
      return app.inject({
        method: "POST",
        url: "/webhooks/didit",
        headers: { "content-type": "application/json", ...headers },
        payload,
      });
    },
  };
}

function bodyOf(eventId: string, wallet: string, status: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      event_id: eventId,
      session_id: `sess-${status}`,
      status,
      vendor_data: wallet,
      environment: "sandbox",
      decision: { name: "Should Not Store", document_number: "secret" },
    })
  );
}

function signedHeaders(
  payload: Buffer,
  secret: string
): Record<string, string> {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return { "x-signature": digest, "x-timestamp": String(NOW) };
}

function snapshot(
  addresses: string[],
  retrievedAt = new Date(NOW * 1000).toISOString()
): OfacSnapshot {
  return {
    id: "version-1",
    retrievedAt,
    sourceUrl:
      "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML",
    sha256: "abc",
    addressCount: addresses.length,
    solAddressCount: addresses.length,
    counts: { SOL: addresses.length },
    addresses: addresses.map((address) => ({
      address,
      currencySymbol: "SOL",
      sdnEntryId: "10",
      programs: ["SDGT"],
    })),
  };
}

function sdnXml(
  rows: Array<{
    symbol: string;
    address: string;
    entryId: string;
    program: string;
  }>
): string {
  const namespace =
    "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML";
  const symbols = [...new Set(rows.map((row) => row.symbol))];
  const programs = [...new Set(rows.map((row) => row.program))];
  const featureTypes = symbols
    .map(
      (symbol, index) =>
        `<FeatureType ID="${index + 1}" FeatureTypeGroupID="1">Digital Currency Address - ${symbol}</FeatureType>`
    )
    .join("");
  const programValues = programs
    .map(
      (program, index) =>
        `<SanctionsProgram ID="${index + 1}" SubsidiaryBodyID="1">${program}</SanctionsProgram>`
    )
    .join("");
  const legal = programs
    .map(
      (_program, index) =>
        `<LegalBasis ID="${index + 1}" LegalBasisTypeID="1" SanctionsProgramID="${index + 1}">basis</LegalBasis>`
    )
    .join("");
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.entryId) ?? [];
    list.push(row);
    grouped.set(row.entryId, list);
  }
  const parties: string[] = [];
  const entries: string[] = [];
  let profileId = 100;
  for (const [entryId, group] of grouped) {
    const features = group
      .map((row) => {
        const typeId = symbols.indexOf(row.symbol) + 1;
        return `<Feature ID="${profileId}${typeId}" FeatureTypeID="${typeId}"><FeatureVersion ID="1" ReliabilityID="1"><VersionDetail DetailTypeID="1">${row.address}</VersionDetail></FeatureVersion></Feature>`;
      })
      .join("");
    const programId = programs.indexOf(group[0].program) + 1;
    parties.push(
      `<DistinctParty FixedRef="${profileId}"><Profile ID="${profileId}" PartySubTypeID="1">${features}<SanctionsEntryReference SanctionsEntryID="${entryId}"/></Profile></DistinctParty>`
    );
    entries.push(
      `<SanctionsEntry ID="${entryId}" ProfileID="${profileId}"><EntryEvent ID="1" EntryEventTypeID="1" LegalBasisID="${programId}"><Date CalendarTypeID="1"><Year>2020</Year><Month>1</Month><Day>1</Day></Date></EntryEvent></SanctionsEntry>`
    );
    profileId += 1;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Sanctions xmlns="${namespace}" Version="3"><ReferenceValueSets><FeatureTypeValues>${featureTypes}</FeatureTypeValues><LegalBasisValues>${legal}</LegalBasisValues><SanctionsProgramValues>${programValues}</SanctionsProgramValues></ReferenceValueSets><DistinctParties>${parties.join("")}</DistinctParties><SanctionsEntries>${entries.join("")}</SanctionsEntries></Sanctions>`;
}

describe("optional Range check", () => {
  it("fails closed when a list was not read and caches that result", async () => {
    let calls = 0;
    const range = new RangeSanctions("key", (async () => {
      calls += 1;
      return json(200, {
        lists_checked: false,
        is_sanctioned: null,
        is_token_blacklisted: false,
      });
    }) as typeof fetch);
    expect(await range.screen(SOLANA)).toEqual({
      status: "unavailable",
      reasonCode: "CHECK_UNAVAILABLE",
    });
    await range.screen(SOLANA);
    expect(calls).toBe(1);
    expect(
      interpretRange(200, {
        lists_checked: true,
        is_sanctioned: true,
        is_token_blacklisted: false,
      })
    ).toEqual({ status: "fail", reasonCode: "LIST_MATCH_WALLET" });
    expect(
      interpretRange(200, {
        lists_checked: true,
        is_sanctioned: false,
        is_token_blacklisted: true,
      })
    ).toEqual({ status: "fail", reasonCode: "LIST_MATCH_WALLET" });
    expect(
      interpretRange(200, {
        lists_checked: true,
        is_sanctioned: false,
        is_token_blacklisted: false,
      })
    ).toEqual({ status: "pass" });
  });
});
