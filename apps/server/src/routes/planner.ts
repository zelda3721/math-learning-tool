import { Hono } from "hono";
import { effectiveLearnerId, type AppState } from "../app.js";
import { checkChatBudget } from "../chatBudget.js";
import { planToday } from "../planner.js";
import { loadVocabulary, vocabBatch } from "../vocabulary.js";
import { moduleEnabled } from "../modules.js";

/**
 * 每日计划：把"今天还剩多少分钟"变成"今天做什么"。
 *
 * 为什么单独一条路由：这是孩子打开应用最先看到的东西，它得能一次说清
 * （复习几张、上哪节课、做多少题），而不是让前端自己拼三个接口再猜顺序。
 * 预算由时长闸给（心跳记的真实使用时间），所以"晚上八点打开"和"早上打开"排出来不一样。
 */
export function plannerRoutes(state: AppState): Hono {
  const app = new Hono();

  app.get("/today", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);

    const budget = checkChatBudget(state.repo, learnerId);
    /*
     * 英语那块只在家长开着英语模块时才算进来：关掉了还排"学几个词"，
     * 孩子点进去只会撞上 403。
     */
    const vocab = moduleEnabled(state.repo, learnerId, "english")
      ? vocabBatch(state.repo, learnerId, loadVocabulary())
      : null;
    const plan = planToday({
      repo: state.repo,
      index: state.knowledge.index,
      store: state.questions,
      learnerId,
      budgetMinutes: budget.remainingMinutes,
      ...(vocab ? { english: { due: vocab.reviews.length, newWords: vocab.newWords.length } } : {}),
    });

    return c.json({ plan, budget });
  });

  return app;
}
