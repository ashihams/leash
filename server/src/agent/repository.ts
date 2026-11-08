import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentStep } from "../../../src/leash/agent-contract.ts";
import { AgentError } from "./provider.ts";

export type AgentRepository = {
  begin: (id: string, userId: string, goal: string) => Promise<void>;
  finish: (id: string, steps: AgentStep[], final: unknown) => Promise<void>;
};
export function agentRepository(client: SupabaseClient): AgentRepository {
  return {
    async begin(id, userId, goal) {
      const { error } = await client.from("agent_runs").insert({ id, user_id: userId, goal, steps: [], final: null });
      if (error?.code === "23505") throw new AgentError("AGENT_RATE_LIMIT", 429);
      if (error) throw new AgentError("AGENT_STORAGE_UNAVAILABLE", 503);
    },
    async finish(id, steps, final) {
      const { error } = await client.from("agent_runs").update({ steps, final }).eq("id", id);
      if (error) throw new AgentError("AGENT_STORAGE_UNAVAILABLE", 503);
    },
  };
}
