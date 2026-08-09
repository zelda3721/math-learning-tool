import { Hono } from "hono";
import { z } from "zod";
import type { AppState } from "../app.js";
import { buildCoverage, verifyNode } from "../knowledgeAdmin.js";

const VerifyNodeSchema = z.object({
  nodeId: z.string().min(1),
  source: z.object({ title: z.string().min(1), url: z.string().optional() }).optional(),
});

/** 知识层管理：coverage 报告 + 节点核验（file-first + lint 闸门） */
export function knowledgeRoutes(state: AppState): Hono {
  const app = new Hono();

  app.get("/coverage", (c) => c.json(buildCoverage(state.knowledge, state.questions)));

  app.post("/verify-node", async (c) => {
    const parsed = VerifyNodeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 nodeId" }, 400);
    const result = verifyNode(state.config.dataDir, parsed.data.nodeId, parsed.data.source);
    if (!result.ok) return c.json({ error: result.error }, 422);
    // file-first 修改成功 → 热替换内存知识层（所有路由读 state.knowledge）
    state.knowledge = result.knowledge;
    state.questions.reload();
    return c.json({ ok: true, nodeId: parsed.data.nodeId, status: "verified" });
  });

  return app;
}
