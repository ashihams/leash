import "dotenv/config";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { buildApp } from "../server/src/app.ts";
import { openDatabase } from "../server/src/db.ts";
import { sqliteGateStore } from "../server/src/gate-store.ts";
import { encodeBase58, decodeBase58 } from "../server/src/bytes.ts";
import { intentMessage } from "../server/src/intent.ts";
import { agentConfig } from "../server/src/agent/config.ts";
import { GroqProvider } from "../server/src/agent/provider.ts";
import { registerAgentRoutes } from "../server/src/agent/routes.ts";

// Explicit integration probe: real Groq, unchanged gate, disposable in-memory
// policy fixtures. No network listener, live screening, Supabase writes or RPC.
const db = openDatabase(":memory:");
const store = sqliteGateStore(db);
const agent = nacl.sign.keyPair();
const key = () => encodeBase58(nacl.sign.keyPair().publicKey);
const mint = key(),
  owner = key(),
  mandate = key();
const vendors = ["North Studio", "Harbor Design"].map((name) => ({
  wallet: key(),
  name,
  country: "IN",
  blocked: false,
}));
for (const vendor of vendors) await store.insertVendor(vendor);
await store.insertMandate({
  mandateId: 7,
  mandate,
  owner,
  agent: encodeBase58(agent.publicKey),
  budget: 2_000_000,
  perPaymentLimit: 1_000_000,
  maxUses: 4,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  deliverySeconds: 3600,
  acceptanceSeconds: 3600,
  category: 7,
  corridors: [{ fromCountry: "US", toCountry: "IN" }],
});
const intents = vendors.map(({ wallet: vendor }) => {
  const payment = randomBytes(32),
    invoice = randomBytes(32);
  return {
    vendor,
    amount: 1_000_000,
    paymentId: payment.toString("hex"),
    invoiceHash: invoice.toString("hex"),
    intentSignature: Buffer.from(
      nacl.sign.detached(
        intentMessage({
          kind: 1,
          paymentId: payment,
          invoiceHash: invoice,
          mandate: decodeBase58(mandate),
          buyer: decodeBase58(owner),
          vendor: decodeBase58(vendor),
          mint: decodeBase58(mint),
          amount: 1_000_000,
          fromCountry: "US",
          toCountry: "IN",
          category: 7,
          purposeCode: 1001,
          invoiceAmount: 1_000_000,
        }),
        agent.secretKey
      )
    ).toString("base64"),
  };
});
const app = buildApp({
  store,
  mint,
  policy: nacl.sign.keyPair(),
  verifier: nacl.sign.keyPair().publicKey,
  policyVersion: 1,
  allowWithoutProviders: true,
});
registerAgentRoutes(app, {
  provider: new GroqProvider(agentConfig(process.env)),
  store,
  mint,
  repository: { async begin() {}, async finish() {} },
  authenticate: async (token) =>
    token === "isolated-probe" ? { id: "isolated-probe" } : null,
  listVendors: async () => db.prepare("SELECT * FROM vendors").all(),
});
try {
  const response = await app.inject({
    method: "POST",
    url: "/agent/run",
    headers: { authorization: "Bearer isolated-probe" },
    payload: {
      goal: "Buy a logo for 1 USDC from an eligible design studio in India. Compare North Studio and Harbor Design, and respect all mandate limits.",
      context: {
        mandate_id: 7,
        vendor_wallets: vendors.map((v) => v.wallet),
        corridor: { fromCountry: "US", toCountry: "IN" },
        intents,
      },
    },
  });
  const body = response.json();
  if (response.statusCode !== 200) {
    console.error(
      `Isolated real-model flow failed: ${body.error || "UNKNOWN_ERROR"}`
    );
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify({
        isolated_probe: true,
        provider: "groq",
        steps: body.steps.map((step) => step.tool),
        decision: body.final.gate_result.decision,
        requires_confirmation: body.final.requires_confirmation,
        alternatives: body.final.alternatives_considered.length,
        onchain_transactions: 0,
      })
    );
  }
} finally {
  await app.close();
  db.close();
}
