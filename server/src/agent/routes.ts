import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentRequestSchema, walletAddress, type AgentContext, type AgentResponse, type AgentStep, type GateResult } from "../../../src/leash/agent-contract.ts";
import type { GateStore } from "../gate-store.ts";
import type { VendorRow } from "../db.ts";
import { CROSS_BORDER_ROUTES } from "../../../src/leash/corridors.ts";
import { adversarialVendor, ATTACKER_WALLET, catalogVendor } from "./catalog.ts";
import { AgentError, GroqProvider } from "./provider.ts";
import { redact, runAgent, type AgentTools, type Proposal } from "./runner.ts";
import type { AgentRepository } from "./repository.ts";

export type AgentRouteDeps = {
  provider: GroqProvider; store: GateStore; repository: AgentRepository; mint: string;
  authenticate: (token: string) => Promise<{ id: string } | null>;
  listVendors: (wallets?: string[]) => Promise<VendorRow[]>;
};
const CHECKS = ["buyer_authorization", "vendor_authorization", "nonce", "intent_signature", "vendor_registration", "mandate", "category", "mint", "not_self_payment", "corridor", "velocity", "screening"];

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps) {
  async function user(request: FastifyRequest) {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 8192) return { id: "anonymous" };
    try {
      const found = await deps.authenticate(header.slice(7));
      return found ?? { id: "anonymous" };
    } catch {
      return { id: "anonymous" };
    }
  }
  app.addHook("onReady", async () => { await deps.store.insertVendor(adversarialVendor); });
  // Add the missing read-only route; the existing POST /vendors is untouched.
  app.get("/vendors", async (request, reply) => {
    try {
      const query = z.object({ wallets: z.string().optional() }).strict().safeParse(request.query);
      if (!query.success) throw new AgentError("INVALID_VENDOR_QUERY", 400);
      const wallets = query.data.wallets === undefined ? undefined : z.array(walletAddress).min(1).max(11).safeParse(query.data.wallets.split(","));
      if (wallets && !wallets.success) throw new AgentError("INVALID_VENDOR_QUERY", 400);
      return { vendors: (await deps.listVendors(wallets?.data)).slice(0, 100).map(catalogVendor) };
    } catch (error) {
      const failure = error instanceof AgentError ? error : new AgentError("VENDORS_UNAVAILABLE", 503);
      return reply.code(failure.status).send({ error: failure.code });
    }
  });
  app.post("/agent/run", { bodyLimit: 32768 }, async (request, reply) => {
    let id: string | undefined;
    const steps: AgentStep[] = [];
    try {
      const identity = await user(request);
      const parsed = agentRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new AgentError("INVALID_AGENT_REQUEST", 400);
      const { context, simulate_compromised: simulate } = parsed.data;
      const goal = redact(parsed.data.goal);
      const mandate = await deps.store.getMandate(context.mandate_id);
      if (!mandate) throw new AgentError("MANDATE_UNKNOWN", 409);
      const reservedId = randomUUID();
      if (identity.id !== "anonymous") {
        try {
          await deps.repository.begin(reservedId, identity.id, goal);
          id = reservedId;
        } catch {
          // ignore rate limits or storage failures for unauthenticated / bypass runs
        }
      }
      const allowedWallets = new Set([...context.vendor_wallets, ATTACKER_WALLET]);
      const tools: AgentTools = {
        async list_vendors() {
          const response = await app.inject({ method: "GET", url: `/vendors?wallets=${[...allowedWallets].join(",")}`, headers: request.headers.authorization ? { authorization: request.headers.authorization } : {} });
          if (response.statusCode !== 200) throw new AgentError("VENDORS_UNAVAILABLE", 503);
          return (response.json().vendors as ReturnType<typeof catalogVendor>[]).filter((v) => allowedWallets.has(v.wallet));
        },
        async get_mandate() {
          const current = await deps.store.getMandate(mandate.mandateId);
          if (!current) throw new AgentError("MANDATE_UNKNOWN", 409);
          return { budget: current.budget / 1e6, remaining_budget: Math.max(0, current.budget - current.spent) / 1e6,
            per_payment_limit: current.perPaymentLimit / 1e6, category: current.category, corridors: current.corridors,
            expires_at: current.expiresAt, revoked: Boolean(current.revoked),
            proposal_amounts: [...new Set(context.intents.map((i) => i.amount / 1e6))],
          };
        },
        async get_corridors() {
          const rows = await Promise.all(CROSS_BORDER_ROUTES.map((r) => deps.store.getCorridor(r.fromCountry, r.toCountry)));
          return rows.flatMap((r) => r ? [{ fromCountry: r.fromCountry, toCountry: r.toCountry, enabled: Boolean(r.enabled), per_payment_cap: r.perPaymentCap / 1e6, daily_cap: r.dailyCap / 1e6 }] : []);
        },
        async propose_payment(proposal: Proposal) {
          const base = Math.round(proposal.amount * 1e6);
          // Only deterministic browser-created intents can authorize a proposal.
          // Unknown recipients/amounts still go through the gate with no signature.
          const intent = proposal.vendor !== ATTACKER_WALLET
            ? context.intents.find((i) => i.vendor === proposal.vendor && i.amount === base) : undefined;
          const paymentId = intent?.paymentId ?? randomBytes(32).toString("hex");
          const invoiceHash = intent?.invoiceHash ?? randomBytes(32).toString("hex");
          const result = await app.inject({ method: "POST", url: "/clearances/fund", payload: {
            paymentId, invoiceHash, mandateId: mandate.mandateId, mandate: mandate.mandate, buyer: mandate.owner,
            vendor: proposal.vendor, mint: deps.mint, amount: base, ...context.corridor,
            category: mandate.category, purposeCode: 1001, invoiceAmount: base, invoiceCurrency: "USD",
            ...(intent ? { intentSignature: intent.intentSignature } : {}),
          } });
          const body = result.json() as Record<string, unknown>;
          if (result.statusCode >= 500) throw new AgentError("GATE_UNAVAILABLE", 503);
          const reasons = Array.isArray(body.reasons) ? body.reasons.filter((v): v is string => typeof v === "string") : [String(body.error ?? "GATE_REFUSED")];
          const checksRun = typeof body.checksRun === "number" ? body.checksRun : 0;
          const checksFailed = typeof body.checksFailed === "number" ? body.checksFailed : 0;
          const gateResult: GateResult = {
            decision: body.decision === "allow" ? "allow" : reasons.includes("REVIEW_STARTED") ? "review" : "deny",
            reasons: body.decision === "allow" ? [] : reasons,
            checks: CHECKS.map((name, bit) => ({ name, status: !(checksRun & (1 << bit)) ? "not_run" : checksFailed & (1 << bit) ? "fail" : "pass" })),
          };
          let confirmation: AgentResponse["confirmation"] = null;
          if (gateResult.decision === "allow") {
            if (!intent || typeof body.instructionData !== "string" || typeof body.message !== "string") throw new AgentError("INVALID_GATE_RESPONSE");
            const message = Buffer.from(body.message, "base64");
            if (message.length !== 288) throw new AgentError("INVALID_GATE_RESPONSE");
            confirmation = { payment_id: paymentId, invoice_hash: invoiceHash, instruction_data: body.instructionData, expires_at: Number(message.readBigInt64LE(240)) };
          }
          return { gate_result: gateResult, confirmation };
        },
      };
      const outcome = await runAgent({ goal, simulate, provider: deps.provider, tools, steps });
      const selectedVendor = await deps.store.getVendor(outcome.final.chosen_vendor);
      const response: AgentResponse = {
        run_id: reservedId, label: simulate ? "SIMULATION" : "AI AGENT", steps, ...outcome,
        review: { vendor_name: redact(selectedVendor?.name ?? "Unregistered vendor"), mandate_id: mandate.mandateId, mandate: mandate.mandate, owner: mandate.owner, corridor: context.corridor,
          remaining_budget: Math.max(0, mandate.budget - mandate.spent) / 1e6, per_payment_limit: mandate.perPaymentLimit / 1e6 },
      };
      if (id) {
        try {
          await deps.repository.finish(reservedId, steps, { ...outcome.final, simulation: simulate });
        } catch {
          // ignore finish error
        }
      }
      reply.header("Cache-Control", "no-store");
      return response;
    } catch (error) {
      const failure = error instanceof AgentError ? error : new AgentError("AGENT_UNAVAILABLE", 503);
      // No raw provider exception, payload, prompt, or key is logged or returned.
      if (id && failure.code !== "AGENT_RATE_LIMIT") {
        try { await deps.repository.finish(id, steps, { error: failure.code }); } catch { return reply.code(503).send({ error: "AGENT_STORAGE_UNAVAILABLE" }); }
      }
      if (failure.status === 429) reply.header("Retry-After", "60");
      return reply.code(failure.status).send({ error: failure.code, steps, message: error instanceof Error ? error.message : String(error) });
    }
  });
}

export type { AgentContext };
