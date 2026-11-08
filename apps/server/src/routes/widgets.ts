import { Hono } from "hono";
import { budgetBlockedPayload } from "../chatBudget.js";
import { z } from "zod";
import { widgetForNode, widgetOf, replayWidget, type WidgetAction } from "@mathtutor/widgets";
import { effectiveLearnerId, type AppState } from "../app.js";
import { pickLessonQuestion, toLessonQuestion } from "../classroom/lesson.js";

/**
 * 交互组件（阶段 3）：探索时动手操作，收尾用一道题把"看懂了"变成证据。
 *
 * 两件事刻意分开：
 * - **动手部分不判分**。组件回答的是"它为什么会这样"，摸到边界就是收获，
 *   给它打分只会让孩子去猜分数想要什么。
 * - **收尾的那道题进证据链**。题来自题库、走 /practice/submit（source=explore），
 *   所以掌握度、证据等级、家长抽检那一整串照旧生效。
 *
 * 这里存的只有"动过什么"（操作序列 + 最终状态），不存任何答案。
 */

const TraceSchema = z.object({
  learnerId: z.string().min(1),
  nodeId: z.string().min(1),
  widget: z.string().min(1),
  actions: z
    .array(
      z.union([
        z.object({ op: z.literal("set"), key: z.string(), value: z.union([z.number(), z.string(), z.boolean()]) }),
        z.object({ op: z.literal("add"), key: z.string(), delta: z.number() }),
        z.object({ op: z.literal("pick"), key: z.string(), value: z.string() }),
        z.object({ op: z.literal("toggle"), key: z.string() }),
        z.object({ op: z.literal("reset") }),
      ]),
    )
    .max(500),
  finalState: z.record(z.union([z.number(), z.string(), z.boolean()])),
});

export function widgetRoutes(state: AppState): Hono {
  const app = new Hono();

  /** 某个知识点配哪个组件；配不上就明说没有，不硬塞一个不相干的 */
  app.get("/for-node", (c) => {
    const nodeId = c.req.query("nodeId");
    if (!nodeId) return c.json({ error: "需要 nodeId" }, 400);
    const node = state.knowledge.index.getNode(nodeId);
    if (!node) return c.json({ error: "知识点不存在" }, 404);
    // 动手探索也占孩子的使用时间，也受同一个闸管
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (learnerId && state.repo.getLearner(learnerId)) {
      const blocked = budgetBlockedPayload(state.repo, learnerId);
      if (blocked) return c.json(blocked, 429);
    }

    const widget = widgetForNode(node);
    const question = pickLessonQuestion(state.questions, nodeId);
    return c.json({
      widget,
      question: question ? toLessonQuestion(question) : null,
      note: widget
        ? "动手玩一玩，最后用一道题收尾——做题才算数。"
        : "这个知识点没有配套的动手组件，可以直接做题。",
    });
  });

  /** 记一次探索：只记操作与最终状态，可重放 */
  app.post("/trace", async (c) => {
    const parsed = TraceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    const body = parsed.data;
    body.learnerId = effectiveLearnerId(c, state, body.learnerId) ?? body.learnerId;
    if (!state.repo.getLearner(body.learnerId)) return c.json({ error: "learner 不存在" }, 404);

    const spec = widgetOf(body.widget);
    if (!spec) return c.json({ error: "没有这个组件" }, 404);

    /*
     * 用服务端自己的规则重放一遍。客户端发来的 finalState 只能当参考：
     * 一份"我拖到了第 99 格"的记录（范围是 0–10）如果照单全收，
     * 家长回看时看到的就是一段根本没发生过的探索。
     */
    const replayed = replayWidget(body.widget, body.actions as WidgetAction[]);
    if (!replayed) return c.json({ error: "重放失败" }, 400);

    state.repo.appendEvent(body.learnerId, "widget-use", {
      widget: body.widget,
      nodeId: body.nodeId,
      actions: body.actions.length,
      finalState: replayed,
      // 客户端报的最终状态和重放不一致时留个痕：这类不一致通常是前端状态机写错了
      mismatch: JSON.stringify(replayed) !== JSON.stringify(body.finalState),
    });

    return c.json({ ok: true, finalState: replayed });
  });

  return app;
}
