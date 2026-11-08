import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorRow } from "../db.ts";
import type { GateStore } from "../gate-store.ts";
import type { LlmConfig } from "./config.ts";
import { GroqProvider, AgentError } from "./provider.ts";
import { agentRepository } from "./repository.ts";
import { registerAgentRoutes } from "./routes.ts";

export function registerRuntimeAgent(app: FastifyInstance, input: { client: SupabaseClient; store: GateStore; config: LlmConfig; mint: string; db?: DatabaseSync }) {
  registerAgentRoutes(app, {
    provider: new GroqProvider(input.config), store: input.store, mint: input.mint,
    repository: agentRepository(input.client),
    async authenticate(token) {
      const { data, error } = await input.client.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id };
    },
    async listVendors(wallets) {
      if (input.db) return input.db.prepare(`SELECT wallet, name, country, blocked FROM vendors ${wallets ? `WHERE wallet IN (${wallets.map(() => "?").join(",")})` : ""} ORDER BY name LIMIT 100`).all(...(wallets ?? [])) as VendorRow[];
      let query = input.client.from("gate_vendors").select("wallet,name,country,blocked").order("name").limit(100);
      if (wallets) query = query.in("wallet", wallets);
      const { data, error } = await query;
      if (error) throw new AgentError("VENDORS_UNAVAILABLE", 503);
      return (data ?? []) as VendorRow[];
    },
  });
}
