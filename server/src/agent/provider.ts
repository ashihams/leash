import { z } from "zod";
import type { LlmConfig } from "./config.ts";

export class AgentError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 502) { super(code); this.code = code; this.status = status; }
}
export const toolCallSchema = z.object({
  id: z.string().min(1).max(100), type: z.literal("function"),
  function: z.object({ name: z.string().max(60), arguments: z.string().max(8000) }).strict(),
}).strict();
const replySchema = z.object({ choices: z.array(z.object({ message: z.object({
  role: z.literal("assistant"), content: z.string().max(20000).nullable().optional(),
  tool_calls: z.array(toolCallSchema).max(5).optional(),
}).passthrough() })).min(1).max(1) });
export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content?: string | null; tool_calls?: z.infer<typeof toolCallSchema>[]; tool_call_id?: string; name?: string };
export class GroqProvider {
  private config: LlmConfig;
  private fetchImpl: typeof fetch;
  constructor(config: LlmConfig, fetchImpl: typeof fetch = fetch) { this.config = config; this.fetchImpl = fetchImpl; }
  async complete(messages: ChatMessage[], options: Record<string, unknown>) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = (async () => {
      const response = await this.fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model: this.config.model, messages, temperature: 0, max_completion_tokens: 3000, ...options }),
        signal: controller.signal,
      });
      if (!response.ok) throw new AgentError("LLM_UNAVAILABLE");
      const raw = await response.text();
      if (raw.length > 100_000) throw new AgentError("LLM_INVALID_OUTPUT");
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new AgentError("LLM_INVALID_JSON"); }
      const result = replySchema.safeParse(parsed);
      if (!result.success) throw new AgentError("LLM_INVALID_OUTPUT");
      const message = result.data.choices[0].message;
      return { role: "assistant" as const, content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
    })();
    try {
      return await Promise.race([request, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new AgentError("LLM_TIMEOUT", 504)); }, 20_000);
      })]);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("LLM_UNAVAILABLE");
    } finally { clearTimeout(timer); }
  }
}
