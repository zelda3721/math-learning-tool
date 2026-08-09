import { Hono } from "hono";
import { z } from "zod";
import type { Question } from "@mathtutor/schema";
import type { AppState } from "../app.js";
import { composeToday } from "../composer.js";
import { grade } from "../grading.js";
import { applyAttempt, effectiveP, masteryBand } from "../mastery.js";
import { makeHint } from "../hint.js";

/** 发给前端的题目视图：绝不包含 answer/analysis（不喂答案从协议层做起） */
function sanitize(q: Question) {
  return {
    id: q.id,
    stem: q.stem,
    options: q.options,
    answerType: q.answerType,
    difficulty: q.difficulty,
    level: q.level,
    nodeIds: q.nodeIds,
    problemTypeId: q.problemTypeId,
  };
}

const TodaySchema = z.object({ learnerId: z.string(), count: z.number().int().min(3).max(8).optional() });
const SubmitSchema = z.object({
  learnerId: z.string(),
  questionId: z.string(),
  answer: z.string().max(500),
  hintLevelUsed: z.number().int().min(0).max(3).default(0),
  durationS: z.number().nonnegative().optional(),
  source: z.enum(["daily", "probe", "variant", "explore"]).default("daily"),
  queueItemId: z.string().optional(),
});
const HintSchema = z.object({
  learnerId: z.string(),
  questionId: z.string(),
  level: z.number().int().min(1).max(3),
  lastWrongAnswer: z.string().max(500).optional(),
});

export function practiceRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/today", async (c) => {
    const parsed = TodaySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId" }, 400);
    const { learnerId, count } = parsed.data;
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);
    const composed = composeToday(state.questions, state.knowledge.index, state.repo, learnerId, { count });
    return c.json({
      items: composed.map((item) => ({
        slot: item.slot,
        queueItemId: item.queueItemId,
        question: sanitize(item.question),
      })),
    });
  });

  app.post("/submit", async (c) => {
    const parsed = SubmitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    const body = parsed.data;
    if (!state.repo.getLearner(body.learnerId)) return c.json({ error: "learner 不存在" }, 404);
    const question = state.questions.byId.get(body.questionId);
    if (!question) return c.json({ error: "题目不存在" }, 404);

    const result = grade(question, body.answer);
    const pending = result.method === "pending";
    const attempt = state.repo.insertAttempt({
      learnerId: body.learnerId,
      questionId: body.questionId,
      answer: body.answer,
      correct: result.correct,
      hintLevelUsed: body.hintLevelUsed as 0 | 1 | 2 | 3,
      source: body.source,
      durationS: body.durationS,
      needsReview: pending,
    });
    if (body.queueItemId) state.repo.consumeQueueItem(body.queueItemId);

    // 掌握度：主观题 pending 不计入证据，等家长裁决（宪法：不污染证据基础）
    const masteryChanges: { nodeId: string; p: number; band: string }[] = [];
    if (!pending) {
      for (const nodeId of question.nodeIds) {
        const current = state.repo.getMastery(body.learnerId, nodeId);
        const next = applyAttempt(
          current ? { p: current.p, evidenceN: current.evidenceN } : undefined,
          result.correct,
          body.hintLevelUsed as 0 | 1 | 2 | 3,
        );
        const row = {
          learnerId: body.learnerId,
          nodeId,
          p: next.p,
          evidenceN: next.evidenceN,
          lastEvidenceAt: new Date().toISOString(),
        };
        state.repo.upsertMastery(row);
        masteryChanges.push({ nodeId, p: next.p, band: masteryBand(next.p, next.evidenceN) });
      }
    }
    state.repo.appendEvent(body.learnerId, "attempt", {
      attemptId: attempt.id,
      questionId: body.questionId,
      correct: result.correct,
      method: result.method,
      hintLevelUsed: body.hintLevelUsed,
      source: body.source,
    });

    return c.json({
      attemptId: attempt.id,
      correct: result.correct,
      method: result.method,
      needsReview: pending,
      hintAvailable: !result.correct && !pending && body.hintLevelUsed < 3,
      mastery: masteryChanges,
    });
  });

  app.post("/hint", async (c) => {
    const parsed = HintSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const { learnerId, questionId, level, lastWrongAnswer } = parsed.data;
    const question = state.questions.byId.get(questionId);
    if (!question) return c.json({ error: "题目不存在" }, 404);
    const { hint, source } = await makeHint(
      state.hintProvider,
      question,
      level as 1 | 2 | 3,
      lastWrongAnswer,
    );
    state.repo.appendEvent(learnerId, "attempt", { kind: "hint", questionId, level, source });
    return c.json({ level, hint, source });
  });

  return app;
}
