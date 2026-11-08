import { z } from "zod";

export const walletAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const text = z.string().min(1).max(1200);
export const agentVendorSchema = z
  .object({
    wallet: walletAddress,
    name: z.string().max(100),
    description: z.string().max(800),
    status: z.enum(["eligible", "blocked"]),
    category: z.number().int(),
    country: z.string().length(2),
  })
  .strict();
export const gateResultSchema = z
  .object({
    decision: z.enum(["allow", "deny", "review"]),
    reasons: z.array(z.string().max(80)).max(30),
    checks: z
      .array(
        z
          .object({
            name: z.string(),
            status: z.enum(["pass", "fail", "not_run"]),
          })
          .strict()
      )
      .max(20),
  })
  .strict();
export const agentFinalSchema = z
  .object({
    goal_summary: z
      .object({
        summary: text,
        budget: z.number().nonnegative().nullable(),
        category: z.number().int().nullable(),
        constraints: z.array(text).max(10),
      })
      .strict(),
    chosen_vendor: walletAddress,
    amount: z.number().positive(),
    reasons: z.array(z.string().max(80)).max(30),
    alternatives_considered: z
      .array(z.object({ vendor: walletAddress, reason: text }).strict())
      .max(5),
    gate_result: gateResultSchema,
    explanation: text,
    requires_confirmation: z.literal(true),
  })
  .strict();
export const agentContextSchema = z
  .object({
    mandate_id: z.number().int().nonnegative(),
    vendor_wallets: z.array(walletAddress).min(1).max(10),
    corridor: z
      .object({
        fromCountry: z.string().regex(/^[A-Z]{2}$/),
        toCountry: z.string().regex(/^[A-Z]{2}$/),
      })
      .strict(),
    intents: z
      .array(
        z
          .object({
            vendor: walletAddress,
            amount: z.number().int().positive().max(1_000_000_000_000),
            paymentId: z.string().regex(/^[a-f0-9]{64}$/),
            invoiceHash: z.string().regex(/^[a-f0-9]{64}$/),
            intentSignature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
          })
          .strict()
      )
      .max(20),
  })
  .strict();
export const agentRequestSchema = z
  .object({
    goal: z.string().trim().min(1).max(1000),
    simulate_compromised: z.boolean().default(false),
    context: agentContextSchema,
  })
  .strict();
export type AgentFinal = z.infer<typeof agentFinalSchema>;
export type AgentContext = z.infer<typeof agentContextSchema>;
export type AgentVendor = z.infer<typeof agentVendorSchema>;
export type GateResult = z.infer<typeof gateResultSchema>;
export type AgentStep = {
  tool: string;
  argument_hash: string;
  summary: string;
};
export type AgentResponse = {
  run_id: string;
  label: "AI AGENT" | "SIMULATION";
  steps: AgentStep[];
  final: AgentFinal;
  review: {
    vendor_name: string;
    mandate_id: number;
    mandate: string;
    owner: string;
    corridor: AgentContext["corridor"];
    remaining_budget: number;
    per_payment_limit: number;
  };
  confirmation: null | {
    payment_id: string;
    invoice_hash: string;
    instruction_data: string;
    expires_at: number;
  };
};
