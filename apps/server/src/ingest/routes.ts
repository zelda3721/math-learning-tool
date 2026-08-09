import { Hono } from "hono";
import type { AppState } from "../app.js";

/**
 * 上传抽取管线（题源主通道）：P1a 并行任务实现中。
 * 契约：POST /upload（文本/图片/PDF → 抽题草稿）、POST /confirm（人工确认入库）。
 */
export function ingestRoutes(_state: AppState): Hono {
  const app = new Hono();
  app.post("/upload", (c) => c.json({ error: "ingest pipeline not yet implemented" }, 501));
  app.post("/confirm", (c) => c.json({ error: "ingest pipeline not yet implemented" }, 501));
  return app;
}
