import { Hono } from "hono";
import { z } from "zod";
import type { AppState } from "../app.js";
import { applyAttempt, countsTowardMastery, effectiveP, masteryBand } from "../mastery.js";
import { loadEvidenceStats } from "../evidence.js";
import { buildIndependenceReport } from "../independence.js";
import { compareAssessments, nextAssessment, summarizeAssessment } from "../assessment.js";
import { chatBudgetReport } from "../chatBudget.js";
import { readProfile, writeProfile } from "../tutorMemory.js";
import { MODULES, readModules, writeModules, type ModuleState } from "../modules.js";
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
    const evidence = loadEvidenceStats(state.repo, state.questions, learnerId);
    const bands = { lit: 0, glow: 0, dim: 0 };
    for (const m of mastery)
      bands[masteryBand(effectiveP(m), m.evidenceN, evidence.get(m.nodeId)) as keyof typeof bands]++;

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
      .filter((m) => m.evidenceN > 0 && masteryBand(m.p, m.evidenceN, evidence.get(m.nodeId)) !== "lit")
      .sort((a, b) => a.p - b.p)
      .slice(0, 10)
      .map((m) => ({
        nodeId: m.nodeId,
        nodeName: state.knowledge.index.getNode(m.nodeId)?.name ?? m.nodeId,
        p: Math.round(m.p * 100) / 100,
        evidenceN: m.evidenceN,
        band: masteryBand(m.p, m.evidenceN, evidence.get(m.nodeId)),
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
  /**
   * 「孩子是在自己学，还是在依赖 AI」——家长端最缺的一组数字。
   *
   * 只做统计，不做评价：新题首答靠自己做对的比例、提示深度分布、
   * 看了几次解析、问过几次题库外的题、重复交了几次、自己讲过几次思路。
   * 口径来自已有记录，不额外让模型判任何东西。
   */
  app.get("/independence", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const events = state.repo.listEvents(learnerId);
    let repeats = 0;
    let selfExplain = 0;
    let errorGuess = 0;
    for (const e of events) {
      const payload = e.payload as { repeatSameDay?: unknown; kind?: unknown } | null;
      if (e.type === "attempt" && payload?.repeatSameDay === true) repeats++;
      if (e.type === "reflection") {
        if (payload?.kind === "self-explain") selfExplain++;
        else if (payload?.kind === "error-guess") errorGuess++;
      }
    }
    const report = buildIndependenceReport({
      attempts: state.repo.attemptsForEvidence(learnerId),
      questions: state.questions,
      analysisViews: state.repo.analysisViews(learnerId),
      askCount: state.repo.countAskJobs(learnerId),
      repeats,
      reflections: { selfExplain, errorGuess },
    });
    return c.json({ learnerId, ...report });
  });

  /**
   * 孩子的自述（元认知记录）：错后先猜自己错在哪、答对后说说怎么想的。
   *
   * 一律标 `ai_unverified`——那是孩子自己的话，判不了对错，也绝不进掌握度。
   * 家长看的是"他会不会讲"，而不是"讲得对不对"。
   */
  app.get("/reflections", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const items = state.repo
      .listEvents(learnerId, "reflection")
      .slice(-30)
      .reverse()
      .map((e) => {
        const p = e.payload as {
          questionId?: unknown;
          kind?: unknown;
          guess?: unknown;
          text?: unknown;
        } | null;
        return {
          at: e.ts,
          questionId: typeof p?.questionId === "string" ? p.questionId : undefined,
          questionStem:
            typeof p?.questionId === "string" ? state.questions.byId.get(p.questionId)?.stem : undefined,
          kind: p?.kind === "self-explain" ? "self-explain" : "error-guess",
          guess: typeof p?.guess === "string" ? p.guess : undefined,
          text: typeof p?.text === "string" ? p.text : undefined,
        };
      });
    return c.json({ items });
  });

  /**
   * 英语口语对练的记录。**内容受家长自己的"记录对话"开关管**（和探索对话同一把锁）：
   * 关着就只回"哪天练了几轮"，不回孩子说了什么。
   */
  app.get("/speaking", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const recording = state.repo.learnerPrefs(learnerId).recordTranscript === true;
    const sessions = state.repo.listSpeakingSessions(learnerId, 10).map((s) => ({
      id: s.id,
      scenarioId: s.scenarioId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      turnCount: s.turns,
      turns: recording
        ? state.repo.listSpeakingTurns(s.id).map((t) => ({
            ts: t.ts,
            role: t.role,
            text: t.role === "blocked" ? "" : t.text,
            latencyMs: t.latencyMs,
          }))
        : [],
    }));
    return c.json({ recording, sessions });
  });

  /**
   * 阶段测评对比：前测 → 后测 → 保持率。
   *
   * 只比两次都覆盖到的节点；两道口径都写清楚（各档几次、答了几道、对了几道），
   * 让家长能自己核对这张表是怎么来的。
   */
  app.get("/assessments", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const list = state.repo.listAssessments(learnerId, 30).filter((a) => a.finishedAt);
    const summaries = list.map((a) => {
      const items = state.repo.listAssessmentItems(a.id);
      return summarizeAssessment(
        a,
        items.map((i) => ({ questionId: i.questionId, correct: i.correct })),
        (qid) => state.questions.byId.get(qid)?.answer ?? "",
        (qid) => state.questions.byId.get(qid)?.nodeIds ?? [],
      );
    });
    const latest = (kind: string) => summaries.find((s) => s.kind === kind);
    const pre = latest("pre");
    const post = latest("post");
    const retention = latest("retention");
    return c.json({
      sessions: summaries.map((s) => ({
        id: s.id,
        kind: s.kind,
        answered: s.answered,
        total: s.total,
        correct: s.correct,
        rate: s.rate,
      })),
      preToPost: pre && post ? compareAssessments(pre, post) : null,
      postToRetention: post && retention ? compareAssessments(post, retention) : null,
      next: nextAssessment(state.repo, learnerId),
    });
  });

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

  /**
   * 对话转写（默认关）。
   *
   * 这一整块的存在前提是家长**明确开过**开关：关着的时候库里一条都没有，
   * 这里也就只能返回空。开关本身跟着返回，省得界面再猜一次当前状态。
   */
  app.get("/transcripts", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200) || 200, 1), 500);
    return c.json({
      recording: state.repo.learnerPrefs(learnerId).recordTranscript === true,
      turns: state.repo.listTranscripts(learnerId, limit),
      note: "默认不记录；开启后只存在这台机器的本地数据库里，随时可以清空。",
    });
  });

  /** 开 / 关转写。关掉之后再打开**不回溯**：没记的那些话找不回来 */
  app.post("/transcripts/recording", async (c) => {
    const parsed = z
      .object({ learnerId: z.string().min(1), enabled: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId 与 enabled" }, 400);
    if (!state.repo.getLearner(parsed.data.learnerId)) return c.json({ error: "learner 不存在" }, 404);
    state.repo.setLearnerPrefs(parsed.data.learnerId, { recordTranscript: parsed.data.enabled });
    return c.json({ recording: parsed.data.enabled });
  });

  /** 清空转写：物理删除。这是家长自己开的记录，删了就该真没了 */
  app.delete("/transcripts", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    return c.json({ removed: state.repo.clearTranscripts(learnerId) });
  });

  /**
   * AI 判断抽查队列：`verification = ai_unverified` 的作答。
   *
   * 为什么单列一队，而不是混进原来的判卷抽检：那队是"判不准、等家长给结论"，
   * 这队是"AI 已经说了话，但那句话没有可复核的依据"。家长看这队不是为了让
   * 那条证据算数（宪法第 5 条：它永远不算数），而是为了知道 **AI 替孩子说过什么**。
   */
  app.get("/ai-judgments", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);

    // 判卷依据：语义判卷那一步会留一条 ai_judge_accepted 事件（含 why）。
    // 事件里没有 attemptId（写入时还没落库），退而按「题 id + 孩子答案」对齐——
    // 同一题同一答案重复作答时可能对上较新那次的理由，能说明"AI 当时凭什么"就够了。
    const whys = new Map<string, string>();
    for (const event of state.repo.listEvents(learnerId, "ai_judge_accepted")) {
      const payload = (event.payload ?? {}) as { questionId?: string; student?: string; why?: string };
      if (payload.questionId && payload.student && payload.why) {
        whys.set(`${payload.questionId}|${payload.student}`, payload.why);
      }
    }
    // 家长已经看过/推翻过的：以最近一条审计事件为准
    const judged = new Map<string, { action: string; note?: string; at: string }>();
    for (const event of state.repo.listEvents(learnerId, "ai_judgment")) {
      const payload = (event.payload ?? {}) as { attemptId?: string; action?: string; note?: string };
      if (payload.attemptId && payload.action) {
        judged.set(payload.attemptId, { action: payload.action, note: payload.note, at: event.ts });
      }
    }

    const items = state.repo.attemptsByVerification(learnerId, "ai_unverified", 50).map((a) => {
      const question = state.questions.byId.get(a.questionId);
      const seen = judged.get(a.id);
      return {
        attemptId: a.id,
        questionId: a.questionId,
        stem: question?.stem.slice(0, 120) ?? a.questionId,
        studentAnswer: a.answer,
        correct: a.correct,
        at: a.at,
        source: a.source,
        hintLevelUsed: a.hintLevelUsed,
        /** 判卷依据：AI 当时给的说明；没有就退回"只有模型判断"这一句 */
        basis: whys.get(`${a.questionId}|${a.answer}`) ?? "只有模型判断，没有可执行验算或可定位的标准答案",
        needsReview: a.needsReview,
        parentVerdict: a.parentVerdict ?? null,
        /** 家长处理过没有：reviewed=看过，overturn=推翻 */
        judgement: seen ?? null,
      };
    });
    return c.json({ items, note: "AI 判断的证据不计入掌握度：这里只作练习记录与抽查。" });
  });

  /**
   * 家长标记「看过 / 推翻」。
   *
   * 两件事都不碰掌握度：宪法第 5 条说 ai_unverified 不承重，推翻它当然也不能
   * 让它突然承重——推翻只是把这条作答挪回「等家长裁决」的队列，
   * 由家长自己给出结论（那是 /verdict 的事，那里会按证据等级重新判一次算不算）。
   */
  app.post("/ai-judgment", async (c) => {
    const parsed = z
      .object({
        attemptId: z.string().min(1),
        action: z.enum(["reviewed", "overturn"]),
        note: z.string().max(200).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 {attemptId, action: reviewed|overturn}" }, 400);
    const attempt = state.repo.getAttempt(parsed.data.attemptId);
    if (!attempt) return c.json({ error: "attempt 不存在" }, 404);
    if (attempt.verification !== "ai_unverified") {
      return c.json({ error: "这条作答不是 AI 判断，走原来的判卷抽检" }, 409);
    }

    if (parsed.data.action === "overturn") {
      state.repo.markAttemptNeedsReview(attempt.id);
    }
    state.repo.appendEvent(attempt.learnerId, "ai_judgment", {
      kind: "ai_judgment",
      attemptId: attempt.id,
      action: parsed.data.action,
      note: parsed.data.note,
      // 审计要留一句"为什么这么处理"：这条证据不改掌握度
      verification: attempt.verification,
    });
    return c.json({ ok: true, needsReview: parsed.data.action === "overturn" });
  });

  /** 模块开关：每个孩子一份，缺键=开 */
  app.get("/modules", (c) => {
    const learnerId = c.req.query("learnerId");
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    return c.json({
      modules: readModules(state.repo, learnerId),
      catalog: MODULES.map((m) => ({ id: m.id, label: m.label, hint: m.hint })),
    });
  });

  app.post("/modules", async (c) => {
    const parsed = z
      .object({
        learnerId: z.string().min(1),
        modules: z.record(z.string(), z.boolean()),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId 与 modules（{explore: false} 这样的对象）" }, 400);
    if (!state.repo.getLearner(parsed.data.learnerId)) return c.json({ error: "learner 不存在" }, 404);

    const known = new Set(MODULES.map((m) => m.id));
    const unknown = Object.keys(parsed.data.modules).filter((k) => !known.has(k));
    if (unknown.length > 0) return c.json({ error: `没有这些模块：${unknown.join("、")}` }, 422);

    const modules: ModuleState = writeModules(state.repo, parsed.data.learnerId, parsed.data.modules);
    state.repo.appendEvent(parsed.data.learnerId, "settings", { kind: "modules", modules });
    return c.json({
      modules,
      catalog: MODULES.map((m) => ({ id: m.id, label: m.label, hint: m.hint })),
    });
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
        const stats = loadEvidenceStats(state.repo, state.questions, attempt.learnerId);
        masteryChanges.push({ nodeId, p: next.p, band: masteryBand(next.p, next.evidenceN, stats.get(nodeId)) });
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
