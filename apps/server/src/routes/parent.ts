import { Hono } from "hono";
import { z } from "zod";
import type { AppState } from "../app.js";
import { applyAttempt, countsTowardMastery, effectiveP, masteryBand } from "../mastery.js";
import { chatBudgetReport } from "../chatBudget.js";
import { readProfile, writeProfile } from "../tutorMemory.js";
import { DEFAULT_DAILY_CHAT_MINUTES } from "@mathtutor/safety";

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

    /**
     * 卡住的题：直接从作答记录汇总，**不经错题本**。
     *
     * 错题本只收录走完归因流程的题（用完三级提示仍错、点了"先跳过"）。
     * 孩子连错三次、第四次自己做对的题不会进错题本——趋势里错误占比涨了、
     * 错题本却空着，家长就看不见孩子到底卡在哪道题（实机上 Pokemon 就是这样）。
     * 这里按题聚合错误作答：错了几次、最后解没解出来、孩子都填了什么。
     */
    const byQuestion = new Map<
      string,
      { wrong: number; solved: boolean; answers: string[]; lastAt: string }
    >();
    for (const a of state.repo.recentAttempts(learnerId)) {
      const entry = byQuestion.get(a.questionId) ?? { wrong: 0, solved: false, answers: [], lastAt: a.at };
      if (a.correct) entry.solved = true;
      else {
        entry.wrong += 1;
        if (entry.answers.length < 3 && a.answer) entry.answers.push(a.answer);
      }
      if (a.at > entry.lastAt) entry.lastAt = a.at;
      byQuestion.set(a.questionId, entry);
    }
    const struggles = [...byQuestion.entries()]
      .filter(([, v]) => v.wrong > 0)
      .map(([questionId, v]) => {
        const q = state.questions.byId.get(questionId);
        const pt = q?.problemTypeId
          ? state.knowledge.problemTypes.find((t) => t.id === q.problemTypeId)
          : undefined;
        return {
          questionId,
          stem: q?.stem.slice(0, 60) ?? questionId,
          answer: q?.answer,
          wrongCount: v.wrong,
          solved: v.solved,
          childAnswers: v.answers,
          nodeNames: (q?.nodeIds ?? []).map((n) => state.knowledge.index.getNode(n)?.name ?? n),
          problemTypeName: pt?.name,
          lastAt: v.lastAt,
        };
      })
      .sort((a, b) => b.wrongCount - a.wrongCount || (a.lastAt < b.lastAt ? 1 : -1))
      .slice(0, 20);

    /** 薄弱知识点：按有效掌握度从低到高，带名字——只给 dim/glow 的计数看不出是哪里弱 */
    const weakNodes = mastery
      .map((m) => ({ nodeId: m.nodeId, p: effectiveP(m), evidenceN: m.evidenceN }))
      .filter((m) => m.evidenceN > 0 && masteryBand(m.p, m.evidenceN) !== "lit")
      .sort((a, b) => a.p - b.p)
      .slice(0, 10)
      .map((m) => ({
        nodeId: m.nodeId,
        nodeName: state.knowledge.index.getNode(m.nodeId)?.name ?? m.nodeId,
        p: Math.round(m.p * 100) / 100,
        evidenceN: m.evidenceN,
        band: masteryBand(m.p, m.evidenceN),
      }));

    return c.json({
      trend: state.repo.dailyStats(learnerId, 14),
      mistakePatterns,
      struggles,
      weakNodes,
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

  /**
   * 待批改的条数。**只回一个数**，为的是能在导航上挂个角标常驻轮询——
   * overview 那个接口要算错因模式、趋势、掌握度，扛不住这种频率。
   *
   * 为什么需要它：孩子做完题看到"已交给家长确认"，可家长那边一点动静都没有，
   * 得自己想起来去翻。判不准转人工是对的，但转过去之后没人知道，
   * 等于这道题就这么悬着了。
   */
  app.get("/pending-count", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ count: 0 });
    return c.json({ count: state.repo.pendingReviewAttempts(learnerId, 200).length });
  });

  /**
   * 孩子被安全层拦下过什么、为什么。
   *
   * 只回"什么时候、哪一类、拦还是转移"，**不回原话**：家长需要的是知情与判断，
   * 不是把孩子的每一句试探都存档——那既没必要，也把日志变成了新的泄露面。
   */
  app.get("/safety", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);

    const events = state.repo
      .listEvents(learnerId, "safety")
      .slice(-50)
      .reverse()
      .map((event) => {
        const payload = (event.payload ?? {}) as { where?: string; action?: string; reason?: string };
        return {
          at: event.ts,
          where: payload.where === "output" ? "模型输出" : "孩子输入",
          action: payload.action === "block" ? "拦下" : "转移话题",
          reason: payload.reason ?? "unknown",
        };
      });

    const byReason: Record<string, number> = {};
    for (const event of events) byReason[event.reason] = (byReason[event.reason] ?? 0) + 1;
    return c.json({ events, byReason, total: events.length });
  });

  /** 今天的对话时长与上限（上限是谁定的也要说清） */
  app.get("/limits", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    return c.json({
      ...chatBudgetReport(state.repo, learnerId),
      defaults: DEFAULT_DAILY_CHAT_MINUTES,
    });
  });

  /** 家长改每日对话时长；`null` 表示恢复按学段默认 */
  app.post("/limits", async (c) => {
    const parsed = z
      .object({ learnerId: z.string().min(1), dailyChatMinutes: z.number().int().min(0).max(240).nullable() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId 与 dailyChatMinutes（0..240，或 null 恢复默认）" }, 400);
    if (!state.repo.getLearner(parsed.data.learnerId)) return c.json({ error: "learner 不存在" }, 404);

    state.repo.setLearnerPrefs(parsed.data.learnerId, {
      dailyChatMinutes: parsed.data.dailyChatMinutes ?? undefined,
    });
    return c.json(chatBudgetReport(state.repo, parsed.data.learnerId));
  });

  /**
   * 导师记住的东西：一条一条列出来，每条都写着它是怎么来的。
   *
   * `includeDeleted` 让家长能看到"我删过什么"——删除是软删除，
   * 审计上留痕，但召回一律不再用它。
   */
  app.get("/memories", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const includeDeleted = c.req.query("includeDeleted") === "1";
    return c.json({ memories: state.repo.listMemories(learnerId, { includeDeleted }) });
  });

  app.delete("/memories/:id", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const removed = state.repo.forgetMemory(learnerId, c.req.param("id"));
    if (!removed) return c.json({ error: "没有这条记忆（可能已删）" }, 404);
    return c.json({ removed: true, remaining: state.repo.listMemories(learnerId).length });
  });

  /** 学习者画像：兴趣、目标、更吃图形还是式子。全部手填，不猜。 */
  app.get("/profile", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    return c.json(readProfile(state.repo, learnerId));
  });

  app.post("/profile", async (c) => {
    const parsed = z
      .object({
        learnerId: z.string().min(1),
        interests: z.array(z.string().max(20)).max(8).optional(),
        goals: z.array(z.string().max(30)).max(5).optional(),
        prefersVisual: z.boolean().nullable().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId 与 interests/goals/prefersVisual" }, 400);
    if (!state.repo.getLearner(parsed.data.learnerId)) return c.json({ error: "learner 不存在" }, 404);
    const { learnerId, ...patch } = parsed.data;
    return c.json(writeProfile(state.repo, learnerId, patch));
  });

  /**
   * 重置一个孩子的学习状态。危险操作：要求把孩子的名字原样再输一遍确认
   * （与题库"整批撤回"同一套防手滑纪律）。
   */
  app.post("/reset-learner", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { learnerId?: string; confirm?: string };
    if (!body.learnerId) return c.json({ error: "需要 learnerId" }, 400);
    const learner = state.repo.getLearner(body.learnerId);
    if (!learner) return c.json({ error: "learner 不存在" }, 404);
    if (body.confirm !== learner.name) {
      return c.json({ error: `请把孩子的名字原样输入确认（${learner.name}）` }, 400);
    }
    const cleared = state.repo.resetLearnerState(body.learnerId);
    return c.json({ ok: true, cleared });
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
    // 家长可以判一个 ai_unverified 的作答，但它仍然不进掌握度：
    // 家长判的是"孩子答得对不对"，而这条证据本身没有可执行/可定位的验证依据
    if (question && countsTowardMastery(attempt.verification)) {
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
