import "dotenv/config";
import { z } from "zod";
import { agentConfig } from "../server/src/agent/config.ts";
import { GroqProvider } from "../server/src/agent/provider.ts";
import { AGENT_TOOLS, toolArguments } from "../server/src/agent/runner.ts";
import { agentFinalSchema } from "../src/leash/agent-contract.ts";
import { ATTACKER_WALLET } from "../server/src/agent/catalog.ts";

// Provider compatibility probe only. No gate, wallet, signing, or funding calls.
const config = agentConfig(process.env);
const provider = new GroqProvider(config);
try {
  const selected = await provider.complete(
    [{ role: "user", content: "Call list_vendors with no arguments." }],
    {
      tools: AGENT_TOOLS,
      tool_choice: { type: "function", function: { name: "list_vendors" } },
      parallel_tool_calls: false,
    }
  );
  const call = selected.tool_calls?.[0];
  if (call?.function.name !== "list_vendors")
    throw new Error("Unexpected tool choice");
  toolArguments.list_vendors.parse(JSON.parse(call.function.arguments));
  const sample = {
    goal_summary: {
      summary: "Provider compatibility probe",
      budget: 1,
      category: 7,
      constraints: ["No payment is made"],
    },
    chosen_vendor: ATTACKER_WALLET,
    amount: 1,
    reasons: ["VENDOR_BLOCKED"],
    alternatives_considered: [],
    gate_result: {
      decision: "deny",
      reasons: ["VENDOR_BLOCKED"],
      checks: [{ name: "vendor_registration", status: "fail" }],
    },
    explanation:
      "This is a schema test fixture, not a gate result. VENDOR_BLOCKED.",
    requires_confirmation: true,
  };
  const result = await provider.complete(
    [
      {
        role: "user",
        content: `Return this test fixture as JSON: ${JSON.stringify(sample)}`,
      },
    ],
    {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "agent_proposal",
          strict: true,
          schema: z.toJSONSchema(agentFinalSchema, { target: "draft-7" }),
        },
      },
    }
  );
  agentFinalSchema.parse(JSON.parse(result.content ?? ""));
  console.log(
    `Groq ${config.model}: tool calling and strict proposal schema verified. No payment requested.`
  );
} catch (error) {
  console.error(
    `Provider probe failed: ${error?.code || "INVALID_PROVIDER_OUTPUT"}`
  );
  process.exitCode = 1;
}
