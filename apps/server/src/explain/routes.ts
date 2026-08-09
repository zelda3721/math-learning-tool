import { Hono } from "hono";
import type { AppState } from "../app.js";

/** P2 讲解管线：并行任务实现中（缓存命中/生成队列/图文兜底/任务轮询）。 */
export function explainRoutes(_state: AppState): Hono {
  const app = new Hono();
  app.post("/", (c) => c.json({ error: "explain pipeline not yet implemented" }, 501));
  app.get("/jobs/:id", (c) => c.json({ error: "explain pipeline not yet implemented" }, 501));
  return app;
}
