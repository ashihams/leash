export type LlmConfig = { provider: "groq"; apiKey: string; model: string };
export function agentConfig(env: NodeJS.ProcessEnv): LlmConfig {
  if (env.LLM_PROVIDER !== "groq" || !env.LLM_API_KEY?.trim() || !env.LLM_MODEL?.trim()) {
    throw new Error("Set LLM_PROVIDER=groq, LLM_API_KEY, and LLM_MODEL before starting the server.");
  }
  return { provider: "groq", apiKey: env.LLM_API_KEY.trim(), model: env.LLM_MODEL.trim() };
}
