import { Hono } from "hono";
import { z } from "zod";
import type { Question } from "@mathtutor/schema";
import { effectiveLearnerId, type AppState } from "../app.js";
import { composeToday } from "../composer.js";
import { grade } from "../grading.js";
import { applyAttempt, effectiveP, masteryBand } from "../mastery.js";
import { makeHint } from "../hint.js";
import { backfillProbeEvidence } from "../diagnosis.js";
import { getVariant } from "../variant.js";
import { advanceReviewCard, ensureReviewCard } from "../review.js";

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
    // 配图是题面的一部分（几何题没图就读不懂），与答案解析不同，必须下发。
    // 原图是主表示，规格只在没有原图时兜底（见 figures.ts）
    figureImage: q.figureImage,
    figure: q.figure,
  };
}

const TodaySchema = z.object({ learnerId: z.string(), count: z.number().int().min(3).max(8).optional() });
const SubmitSchema = z.object({
  learnerId: z.string(),
  questionId: z.string(),
  answer: z.string().max(500),
  hintLevelUsed: z.number().int().min(0).max(3).default(0),
  durationS: z.number().nonnegative().optional(),
  source: z.enum(["daily", "probe", "variant", "review", "explore"]).default("daily"),
  queueItemId: z.string().optional(),
  reviewCardId: z.string().optional(),
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
    const { count } = parsed.data;
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId) ?? parsed.data.learnerId;
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);
    const composed = composeToday(state.questions, state.knowledge.index, state.repo, learnerId, { count });
    return c.json({
      items: composed.map((item) => ({
        slot: item.slot,
        queueItemId: item.queueItemId,
        reviewCardId: item.reviewCardId,
        question: sanitize(item.question),
      })),
    });
  });

  // 学生「下一步」一句话建议（元认知首版：点亮地图 + 一条下一步，设计 §04）
  app.get("/next-step", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const dueReviews = state.repo.countDueReviews(learnerId);
    if (dueReviews > 0) {
      return c.json({ nextStep: `有 ${dueReviews} 张复习卡到期了——先把之前的错题用新题练一遍。`, kind: "review" });
    }
    const mastery = state.repo.allMastery(learnerId);
    const weakest = mastery
      .map((m) => ({ nodeId: m.nodeId, p: effectiveP(m), evidenceN: m.evidenceN }))
      .filter((m) => m.evidenceN > 0 && masteryBand(m.p, m.evidenceN) !== "lit")
      .sort((a, b) => a.p - b.p)[0];
    if (weakest && (state.questions.byNode.get(weakest.nodeId) ?? []).length) {
      const name = state.knowledge.index.getNode(weakest.nodeId)?.name ?? weakest.nodeId;
      return c.json({ nextStep: `「${name}」还差一点就点亮了，今天练它。`, kind: "weak", nodeId: weakest.nodeId });
    }
    return c.json({ nextStep: "开始今天的新题，探索一颗新星星。", kind: "new" });
  });

  // 拍照作答判卷（P3）：vision 识别手写 → 确定性判卷；低置信度进家长抽检
  const PhotoSchema = z.object({
    learnerId: z.string(),
    questionId: z.string(),
    /** 图片 base64（可带 data URL 前缀） */
    image: z.string().min(1),
    hintLevelUsed: z.number().int().min(0).max(3).default(0),
    durationS: z.number().nonnegative().optional(),
    source: z.enum(["daily", "probe", "variant", "review", "explore"]).default("daily"),
    queueItemId: z.string().optional(),
    reviewCardId: z.string().optional(),
  });

  app.post("/submit-photo", async (c) => {
    const parsed = PhotoSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId/questionId/image" }, 400);
    const body = parsed.data;
    body.learnerId = effectiveLearnerId(c, state, body.learnerId) ?? body.learnerId;
    if (!state.photoGrader) return c.json({ error: "拍照判卷需配置 vision LLM 端点" }, 501);
    if (!state.repo.getLearner(body.learnerId)) return c.json({ error: "learner 不存在" }, 404);
    const question = state.questions.byId.get(body.questionId);
    if (!question) return c.json({ error: "题目不存在" }, 404);

    const m = /^data:([\w/+.-]+);base64,/.exec(body.image);
    const base64 = m ? body.image.slice(m[0].length) : body.image;
    const mime = m?.[1] ?? "image/jpeg";
    let extracted: { answer: string; confident: boolean };
    try {
      extracted = await state.photoGrader.extractAnswer(base64, mime, question.stem);
    } catch (err) {
      return c.json({ error: `识别失败: ${String(err)}` }, 502);
    }

    const result = grade(question, extracted.answer);
    // 低置信度识别：无论判对错都进家长抽检（识别错误不能污染掌握度证据）
    const needsReview = !extracted.confident || result.method === "pending";
    const attempt = state.repo.insertAttempt({
      learnerId: body.learnerId,
      questionId: body.questionId,
      answer: extracted.answer,
      correct: result.correct,
      hintLevelUsed: body.hintLevelUsed as 0 | 1 | 2 | 3,
      source: body.source,
      durationS: body.durationS,
      needsReview,
    });
    if (body.queueItemId) state.repo.consumeQueueItem(body.queueItemId);

    const masteryChanges: { nodeId: string; p: number; band: string }[] = [];
    let review: { stage: number; mastered: boolean; nextReviewAt: string | null } | undefined;
    if (!needsReview) {
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
      if (body.source === "probe") backfillProbeEvidence(state.repo, body.learnerId, question, result.correct);
      if (body.reviewCardId) review = advanceReviewCard(state.repo, body.reviewCardId, result.correct);
      else if (!result.correct && body.source === "daily") ensureReviewCard(state.repo, body.learnerId, body.questionId);
    }
    state.repo.appendEvent(body.learnerId, "attempt", {
      attemptId: attempt.id,
      questionId: body.questionId,
      correct: result.correct,
      method: "photo",
      extractedAnswer: extracted.answer,
      confident: extracted.confident,
    });

    return c.json({
      attemptId: attempt.id,
      correct: result.correct,
      extractedAnswer: extracted.answer,
      confident: extracted.confident,
      needsReview,
      hintAvailable: !result.correct && !needsReview && body.hintLevelUsed < 3,
      mastery: masteryChanges,
      review,
    });
  });

  app.post("/submit", async (c) => {
    const parsed = SubmitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    const body = parsed.data;
    body.learnerId = effectiveLearnerId(c, state, body.learnerId) ?? body.learnerId;
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

    // 探针作答回填归因证据（宪法第 4 条：探针是证据，图遍历只是假设）
    if (body.source === "probe" && !pending) {
      backfillProbeEvidence(state.repo, body.learnerId, question, result.correct);
    }

    // SM-2 推进（复习卡作答）；日常答错自动入复习（宪法第 3 条）
    let review: { stage: number; mastered: boolean; nextReviewAt: string | null } | undefined;
    if (body.reviewCardId && !pending) {
      review = advanceReviewCard(state.repo, body.reviewCardId, result.correct);
    } else if (!pending && !result.correct && body.source === "daily") {
      ensureReviewCard(state.repo, body.learnerId, body.questionId);
    }

    return c.json({
      attemptId: attempt.id,
      correct: result.correct,
      method: result.method,
      needsReview: pending,
      hintAvailable: !result.correct && !pending && body.hintLevelUsed < 3,
      mastery: masteryChanges,
      review,
    });
  });

  // 变式验证门供给（宪法第 1、3 条）：题库优先 > LLM 生成（进抽检）> 降级入复习队列
  app.post("/variant", async (c) => {
    const parsed = z
      .object({ learnerId: z.string(), questionId: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId 与 questionId" }, 400);
    parsed.data.learnerId = effectiveLearnerId(c, state, parsed.data.learnerId) ?? parsed.data.learnerId;
    const result = await getVariant({
      store: state.questions,
      repo: state.repo,
      llm: state.hintProvider,
      dataDir: state.config.dataDir,
      learnerId: parsed.data.learnerId,
      questionId: parsed.data.questionId,
    });
    if ("error" in result) return c.json({ error: result.error }, 404);
    if (result.kind === "none") {
      return c.json({ kind: "none", message: "暂无合适的变式题，已排进明天的复习队列——明天做对同类题一样点亮。" });
    }
    return c.json({ kind: result.kind, question: sanitize(result.question) });
  });

  app.post("/hint", async (c) => {
    const parsed = HintSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const { questionId, level, lastWrongAnswer } = parsed.data;
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId) ?? parsed.data.learnerId;
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
