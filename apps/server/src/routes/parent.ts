import { Hono } from "hono";
import { z } from "zod";
import type { AppState } from "../app.js";
import { applyAttempt, effectiveP, masteryBand } from "../mastery.js";

/**
 * 家长只读聚合 + 裁决通道（P3，设计 §04 元认知视图）：
 * 错因模式聚合、14 天趋势、判卷抽检队列、归因纠错。
 * AgentTimeline 式观测归家长——学生视图只保留点亮地图和一条「下一步」。
 */
export function parentRoutes(state: AppState): Hono {
  const app = new Hono();

  app.get("/summary", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);

    // 错因模式聚合：按根因节点分组（「分数应用题 70% 根因在单位1」式的因果卡）
    const mistakes = state.repo.listMistakes(learnerId, 200);
    const byRoot = new Map<string, { count: number; confidenceSum: number; latest: string }>();
    for (const m of mistakes) {
      const entry = byRoot.get(m.rootNodeId) ?? { count: 0, confidenceSum: 0, latest: m.createdAt };
      entry.count++;
      entry.confidenceSum += m.confidence;
      if (m.createdAt > entry.latest) entry.latest = m.createdAt;
      byRoot.set(m.rootNodeId, entry);
    }
    const mistakePatterns = [...byRoot.entries()]
      .map(([nodeId, v]) => ({
        nodeId,
        nodeName: state.knowledge.index.getNode(nodeId)?.name ?? nodeId,
        count: v.count,
        share: mistakes.length ? Math.round((v.count / mistakes.length) * 100) : 0,
        avgConfidence: Math.round((v.confidenceSum / v.count) * 100) / 100,
        latest: v.latest,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 判卷抽检队列（主观题/低置信拍照识别/LLM 生成题作答）
    const pendingVerdicts = state.repo.pendingReviewAttempts(learnerId).map((a) => ({
      attemptId: a.id,
      questionId: a.questionId,
      questionStem: state.questions.byId.get(a.questionId)?.stem ?? a.questionId,
      correctAnswer: state.questions.byId.get(a.questionId)?.answer,
      studentAnswer: a.answer,
      at: a.at,
    }));

    // 掌握度总览
    const mastery = state.repo.allMastery(learnerId);
    const bands = { lit: 0, glow: 0, dim: 0 };
    for (const m of mastery) bands[masteryBand(effectiveP(m), m.evidenceN) as keyof typeof bands]++;

    return c.json({
      trend: state.repo.dailyStats(learnerId, 14),
      mistakePatterns,
      pendingVerdicts,
      mastery: { ...bands, tracked: mastery.length },
      dueReviews: state.repo.countDueReviews(learnerId),
      // 讲解画面来源分布（全库口径的产线质量指标，不分孩子）：
      // 掉到 LLM 导演的比例越高，画质越不稳定——先看得见，才谈得上调
      explanationSources: state.repo.explanationSources(),
      recentMistakes: mistakes.slice(0, 20).map((m) => ({
        id: m.id,
        questionStem: state.questions.byId.get(m.questionId)?.stem,
        rootNodeId: m.rootNodeId,
        rootNodeName: state.knowledge.index.getNode(m.rootNodeId)?.name ?? m.rootNodeId,
        confidence: m.confidence,
        eligible: m.eligible,
        correctedByParent: (m as { correctedByParent?: boolean }).correctedByParent ?? false,
        createdAt: m.createdAt,
      })),
    });
  });

  // 判卷裁决：pending 作答此前不计掌握度，裁决后按结论补记（不污染证据基础）
  const VerdictSchema = z.object({
    attemptId: z.string(),
    verdict: z.enum(["correct", "incorrect"]),
    note: z.string().max(200).optional(),
  });
  app.post("/verdict", async (c) => {
    const parsed = VerdictSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 {attemptId, verdict}" }, 400);
    const attempt = state.repo.getAttempt(parsed.data.attemptId);
    if (!attempt) return c.json({ error: "attempt 不存在" }, 404);
    if (!attempt.needsReview) return c.json({ error: "该作答不在抽检队列" }, 409);

    state.repo.setAttemptVerdict(parsed.data.attemptId, parsed.data.verdict, parsed.data.note);
    const question = state.questions.byId.get(attempt.questionId);
    const masteryChanges: { nodeId: string; p: number; band: string }[] = [];
    if (question) {
      const correct = parsed.data.verdict === "correct";
      for (const nodeId of question.nodeIds) {
        const current = state.repo.getMastery(attempt.learnerId, nodeId);
        const next = applyAttempt(
          current ? { p: current.p, evidenceN: current.evidenceN } : undefined,
          correct,
          attempt.hintLevelUsed as 0 | 1 | 2 | 3,
        );
        state.repo.upsertMastery({
          learnerId: attempt.learnerId,
          nodeId,
          p: next.p,
          evidenceN: next.evidenceN,
          lastEvidenceAt: new Date().toISOString(),
        });
        masteryChanges.push({ nodeId, p: next.p, band: masteryBand(next.p, next.evidenceN) });
      }
    }
    state.repo.appendEvent(attempt.learnerId, "feedback", {
      kind: "parent_verdict",
      attemptId: attempt.id,
      verdict: parsed.data.verdict,
    });
    return c.json({ ok: true, mastery: masteryChanges });
  });

  // 归因纠错：家长认为根因不对（可选改指到别的节点）
  const CorrectSchema = z.object({ mistakeId: z.string(), rootNodeId: z.string().optional() });
  app.post("/correct-mistake", async (c) => {
    const parsed = CorrectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 mistakeId" }, 400);
    if (parsed.data.rootNodeId && !state.knowledge.index.nodeById.has(parsed.data.rootNodeId)) {
      return c.json({ error: `节点不存在: ${parsed.data.rootNodeId}` }, 422);
    }
    const mistake = state.repo.getMistake(parsed.data.mistakeId);
    if (!mistake) return c.json({ error: "mistake 不存在" }, 404);
    state.repo.correctMistake(parsed.data.mistakeId, parsed.data.rootNodeId);
    state.repo.appendEvent(mistake.learnerId, "feedback", {
      kind: "attribution_corrected",
      mistakeId: mistake.id,
      newRootNodeId: parsed.data.rootNodeId,
    });
    return c.json({ ok: true });
  });

  return app;
}
