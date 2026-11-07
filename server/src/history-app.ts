import Fastify, { type FastifyInstance } from "fastify";
import {
  registerHistoryRoutes,
  type HistoryDeps,
} from "./routes/history.ts";

export async function buildHistoryApp(
  deps: HistoryDeps,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerHistoryRoutes(app, deps);
  return app;
}
