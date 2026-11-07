import { Hono } from "hono";
import { z } from "zod";
import { BREAK_AFTER_MINUTES, shouldSuggestBreak } from "@mathtutor/safety";
import { effectiveLearnerId, type AppState } from "../app.js";
import { checkChatBudget, recordActiveUsage } from "../chatBudget.js";

/**
 * 使用时长：心跳上报 + 今天还剩多少。
 *
 * 两个理由让它必须是一条独立的路由，而不是"聊完记一笔"：
 * - 时长上限管的是**孩子用了多久**，不是模型跑了多久。上课、做题、看讲解都算，
 *   而这些大多不经过对话接口；
 * - 孩子页面开着、人离开的情况必须不计时——只在标签页可见时计时，
 *   这件事只有前端知道，所以由前端心跳上报、服务端按真实流逝封顶。
 */

const ActiveSchema = z.object({
  learnerId: z.string().min(1),
  /** 上次上报以来**可见**的秒数 */
  seconds: z.number().min(0).max(600),
  /** 本次连续使用已多久（分钟）：到点了给一句休息提醒 */
  continuousMinutes: z.number().min(0).max(600).optional(),
});

export function usageRoutes(state: AppState): Hono {
  const app = new Hono();

  app.get("/today", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);
    const budget = checkChatBudget(state.repo, learnerId);
    return c.json({ ...budget, breakAfterMinutes: BREAK_AFTER_MINUTES });
  });

  app.post("/active", async (c) => {
    const parsed = ActiveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId) ?? parsed.data.learnerId;
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);

    const { recorded, rejected } = recordActiveUsage(state.repo, learnerId, parsed.data.seconds);
    const budget = checkChatBudget(state.repo, learnerId);
    return c.json({
      recorded,
      // 报上来的数明显超过真实流逝：按真实值记账，并且让前端知道没被采信
      clamped: rejected,
      budget,
      breakDue: shouldSuggestBreak(parsed.data.continuousMinutes ?? 0),
      breakAfterMinutes: BREAK_AFTER_MINUTES,
    });
  });

  return app;
}
