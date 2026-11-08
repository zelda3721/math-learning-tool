import { Hono, type Context } from "hono";
import { z } from "zod";
import { AttemptSourceSchema, type Question } from "@mathtutor/schema";
import { MASTERY_PARAMS } from "@mathtutor/schema";
import { effectiveLearnerId, type AppState } from "../app.js";
import { composeToday } from "../composer.js";
import { getSubjectRegistry, judgeAnswer } from "../subjects.js";
import { applyAttempt, countsTowardMastery, effectiveP, masteryBand } from "../mastery.js";
import { loadEvidenceStats } from "../evidence.js";
import { makeHint } from "../hint.js";
import { backfillProbeEvidence } from "../diagnosis.js";
import { getVariant } from "../variant.js";
import { practiceReady } from "../questions.js";
import { checkChatBudget } from "../chatBudget.js";
import { screenLearnerInput } from "../safety.js";
import { advanceReviewCard, ensureReviewCard } from "../review.js";

/**
 * 谁在作答：孩子本人，还是家长在孩子的页面上试做。
 *
 * 家长试做要留痕（家长自己能回看），但**不能进掌握度**——否则家长点两下
 * 就把孩子的星点亮了，而那条证据里没有孩子的任何行为。
 */
function callerActor(c: Context): "child" | "parent" {
  return (c.get("user") as { role?: string } | undefined)?.role === "parent" ? "parent" : "child";
}

/**
 * 这个作答算不算"试着答了"。
 *
 * 乱填、只写「不会」会让规则判卷返回 pending。早先前端把 pending 当完成，
 * 于是"打几个字"就是一条零代价的跳题捷径——比认真答错还划算。
 * 这里把它和"判不准但确实答了"分开：前者不算一次作答，题留在原地。
 */
const GIVE_UP = new Set([
  "不会", "不会做", "不知道", "不懂", "没学过", "我不想做", "不想做", "跳过", "略", "不会写",
  "我不会", "随便", "哈哈", "不会啊", "太难了",
]);

export function looksLikeGiveUp(answer: string): boolean {
  const trimmed = answer.trim();
  if (!trimmed) return true;
  // 去掉标点与空白后再比：」不会。「 也是「不会」
  const bare = trimmed.replace(/[\s，。！？、,.!?~～…—\-"'“”‘’()（）]/g, "");
  if (/^[0-9A-Za-z一-鿿]+$/.test(bare) && GIVE_UP.has(bare)) return true;
  // 一个字符都算不上作答（全是 emoji、问号、破折号）
  return !/[0-9A-Za-z一-鿿]/.test(bare);
}

/** 发给前端的题目视图：绝不包含 answer/analysis（不喂答案从协议层做起） */
function sanitize(q: Question) {
  return {
    id: q.id,
    stem: q.stem,
    // 双语题的英文题面与作答语言：题面本身就是要做题的材料，必须下发
    stemEn: q.stemEn,
    answerLang: q.answerLang,
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
    // 这里刻意**不下发** analysisImage：那是老师画在【解析】里的解法图
    // （「所求阴影部分面积等于下图中阴影部分面积」——图一给出来这道题就没了）。
    // 它只在讲解时用。这个白名单是唯一挡住它的地方，别顺手加进来。
  };
}

const TodaySchema = z.object({ learnerId: z.string(), count: z.number().int().min(3).max(8).optional() });
const SubmitSchema = z.object({
  learnerId: z.string(),
  questionId: z.string(),
  answer: z.string().max(500),
  hintLevelUsed: z.number().int().min(0).max(3).default(0),
  durationS: z.number().nonnegative().optional(),
  source: AttemptSourceSchema.default("daily"),
  queueItemId: z.string().optional(),
  reviewCardId: z.string().optional(),
});
const HintSchema = z.object({
  learnerId: z.string(),
  questionId: z.string(),
  level: z.number().int().min(1).max(3),
  lastWrongAnswer: z.string().max(500).optional(),
});

/**
 * 元认知通道（P1：从"拦"转向"养"）。
 *
 * 孩子先说出自己的想法，再看系统的归因——**先说的那句是证据，但不是分数**。
 * 它记成 `reflection` 事件：`ai_unverified`（这是自由表达，判不了对错），
 * 所以不进掌握度、不点亮星、不推进 SM-2。它的用处有两个：
 * ① 让孩子把"我错了"变成"我错在哪一步"；
 * ② 让家长看见孩子是不是在依赖 AI（先自述再看讲解，和直接看解析是两种人）。
 */
const ReflectionSchema = z.object({
  learnerId: z.string(),
  questionId: z.string(),
  attemptId: z.string().optional(),
  /** error-guess = 错后先猜自己错在哪种环节；self-explain = 答对后说说怎么想的 */
  kind: z.enum(["error-guess", "self-explain"]),
  /** 与归因结果的 surface 同一套取值，界面才比得起来 */
  guess: z.enum(["reading", "calculation", "procedure", "concept", "unknown"]).optional(),
  text: z.string().max(500).optional(),
});

export function practiceRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/today", async (c) => {
    const parsed = TodaySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId" }, 400);
    const { count } = parsed.data;
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId) ?? parsed.data.learnerId;
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);
    /*
     * 时长上限在**开始一组练习之前**拦：聊完再做题也一样算使用时间。
     * 拦在入口而不是每条 submit 上——半组题被掐断，孩子只会以为自己出错了。
     */
    const budget = checkChatBudget(state.repo, learnerId);
    if (!budget.allowed) {
      return c.json(
        {
          error: `今天的时间用完了（每天 ${budget.limitMinutes} 分钟）。明天再来，或者先去和家长说一声。`,
          budget,
        },
        429,
      );
    }
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
    const stats = loadEvidenceStats(state.repo, state.questions, learnerId);
    const weakest = mastery
      .map((m) => ({ nodeId: m.nodeId, p: effectiveP(m), evidenceN: m.evidenceN }))
      .filter((m) => m.evidenceN > 0 && masteryBand(m.p, m.evidenceN, stats.get(m.nodeId)) !== "lit")
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
    // 直接引用 schema 的枚举：两处各写一份，加来源时必有一处漏掉
    source: AttemptSourceSchema.default("daily"),
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
    const registry = state.subjects ?? getSubjectRegistry();

    const m = /^data:([\w/+.-]+);base64,/.exec(body.image);
    const base64 = m ? body.image.slice(m[0].length) : body.image;
    const mime = m?.[1] ?? "image/jpeg";
    let extracted: { answer: string; confident: boolean };
    try {
      extracted = await state.photoGrader.extractAnswer(base64, mime, question.stem);
    } catch (err) {
      return c.json({ error: `识别失败: ${String(err)}` }, 502);
    }

    const result = await judgeAnswer(registry, state.knowledge, question, extracted.answer);
    // 低置信度识别：无论判对错都进家长抽检（识别错误不能污染掌握度证据）
    // 没有判卷器时也不自己判：转家长，而不是让一条无依据的判定进掌握度
    const needsReview = !extracted.confident || result.method === "pending" || !result.hasJudge;
    // 两条提交路径同一套纪律：家长试做不进证据、同题同日只认第一次
    const actor = callerActor(c);
    const todayCounts = actor === "child" ? state.repo.todayAttemptCounts(body.learnerId, body.questionId) : { correct: 0, wrong: 0 };
    const repeatSameDay = actor === "child" && (result.correct ? todayCounts.correct > 0 : todayCounts.wrong > 0);
    const queueKind = body.queueItemId ? state.repo.getQueueItem(body.queueItemId)?.kind : undefined;
    const source: typeof body.source =
      queueKind === "probe" ? "probe" : body.source === "probe" ? "daily" : body.source;
    const attempt = state.repo.insertAttempt({
      learnerId: body.learnerId,
      questionId: body.questionId,
      answer: extracted.answer,
      correct: result.correct,
      hintLevelUsed: body.hintLevelUsed as 0 | 1 | 2 | 3,
      source,
      durationS: body.durationS,
      needsReview,
      verification: result.verification,
      actor,
    });
    if (body.queueItemId) state.repo.consumeQueueItem(body.queueItemId);

    const masteryChanges: { nodeId: string; p: number; band: string }[] = [];
    let review: { stage: number; mastered: boolean; nextReviewAt: string | null } | undefined;
    const counted =
      !needsReview &&
      countsTowardMastery(attempt.verification) &&
      actor === "child" &&
      !repeatSameDay &&
      practiceReady(question);
    if (counted) {
      const viewed = state.repo.viewedAnalysisBefore(body.learnerId, body.questionId, attempt.at);
      const stats = loadEvidenceStats(state.repo, state.questions, body.learnerId);
      question.nodeIds.forEach((nodeId, index) => {
        const current = state.repo.getMastery(body.learnerId, nodeId);
        const next = applyAttempt(
          current ? { p: current.p, evidenceN: current.evidenceN } : undefined,
          result.correct,
          body.hintLevelUsed as 0 | 1 | 2 | 3,
          (viewed ? MASTERY_PARAMS.afterAnalysisGainFactor : 1) * (index === 0 ? 1 : 0.5),
        );
        const row = {
          learnerId: body.learnerId,
          nodeId,
          p: next.p,
          evidenceN: next.evidenceN,
          lastEvidenceAt: new Date().toISOString(),
        };
        state.repo.upsertMastery(row);
        masteryChanges.push({ nodeId, p: next.p, band: masteryBand(next.p, next.evidenceN, stats.get(nodeId)) });
      });
      if (source === "probe") backfillProbeEvidence(state.repo, body.learnerId, question, result.correct);
      if (body.reviewCardId) review = advanceReviewCard(state.repo, body.reviewCardId, result.correct);
      else if (!result.correct && source === "daily") ensureReviewCard(state.repo, body.learnerId, body.questionId);
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
      countedTowardMastery: counted,
      trial: actor === "parent",
      repeat: repeatSameDay,
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
    const registry = state.subjects ?? getSubjectRegistry();

    let result = await judgeAnswer(registry, state.knowledge, question, body.answer);
    /**
     * 规则判不准时，问模型「是不是同一个意思」。
     *
     * **只许判对，不许判错**：模型说 correct 才生效，说 wrong/unsure、
     * 超时、答非所问，一律维持 pending 交家长（见 semanticJudge.ts 的纪律）。
     * 放行的每一次都记事件，家长可审。
     */
    if (result.method === "pending" && state.judge) {
      const verdict = await state.judge({
        stem: question.stem,
        reference: question.answer,
        student: body.answer,
      });
      if (verdict?.verdict === "correct") {
        /*
         * 模型只在这条路上被允许"判对"，但这条路径的判定**只能是 ai_unverified**：
         * 规则判卷器已经说了"判不准"，此刻唯一的依据就是模型的判断。
         * 按宪法第 5 条，它记进作答、留审计事件，但**不进掌握度**——
         * 否则等于让「模型说对」点亮一颗星，而这件事无法复核。
         *
         * 孩子想让它算数，就再答一次让规则判卷器判得出来；那不是刁难，
         * 而是"理解由行为验证"的本意（宪法第 1 条）。
         */
        result = { correct: true, method: "numeric", verification: "ai_unverified", hasJudge: true };
        state.repo.appendEvent(body.learnerId, "ai_judge_accepted", {
          questionId: body.questionId,
          student: body.answer,
          reference: question.answer,
          why: verdict.why,
          // 审计要说清这条"对"凭什么算数（不算数也算一种交代）
          verification: "ai_unverified",
        });
      }
    }
    const pending = result.method === "pending";
    /*
     * 乱填 / 只写「不会」：这**不是一次作答**。
     *
     * 早先前端把判不准（pending）当完成，于是"打几个字"就是一条零代价的跳题捷径，
     * 比认真答错还划算。这里把两类都挡住：判不准但同时明显没在作答的，
     * 以及判卷器判成"错"但其实只是放弃话术的（"不会" 两个字会被规则判成 string）。
     *
     * 不写 attempt（它本来就不是作答），只留一条 giveup 事件：
     * 家长看得到孩子说「不会」，但这个动作既不扣分也不占掉今天的证据名额。
     */
    if (looksLikeGiveUp(body.answer) && !result.correct) {
      state.repo.appendEvent(body.learnerId, "giveup", { questionId: body.questionId, answer: body.answer });
      return c.json({
        attemptId: null,
        correct: false,
        method: result.method,
        needsReview: false,
        notAnAnswer: true,
        verification: result.verification,
        countedTowardMastery: false,
        trial: callerActor(c) === "parent",
        repeat: false,
        hintAvailable: body.hintLevelUsed < 3,
        mastery: [],
      });
    }
    /*
     * 题目本身可不可信，和"判卷判得准不准"是两件事，但都会让一条证据作废。
     *
     * `answerUnverified`（参考答案是模型自己算的、还没人核对）的题，本该由
     * practiceReady 挡在选题那一侧；可这条路由按 id 取题，绕过了选题。所以在这里
     * 再挡一次：作答照常记录（孩子做过的痕迹不能丢），但**不进掌握度、不推进 SM-2**，
     * 一律进家长抽检。少了这一句，变式题那条路上漏标的题会直接从侧门点亮节点。
     */
    const untrustedQuestion = !practiceReady(question);
    const actor = callerActor(c);
    // 这道题是不是孩子第一次见：第一次就自己答对，是最值得问"你是怎么想的"的时刻
    const seenBefore = state.repo.attemptedQuestionIds(body.learnerId).has(body.questionId);
    /*
     * 同一道题同一天最多认「一次错」和「一次对」。
     *
     * ① 反复交错答案不再连续 ×0.6 扣分——旧口径能把一颗本来点亮的星打回暗；
     * ② 同一道题重交「对」也不再刷成新证据——测到的是记忆，不是理解。
     * 重复作答照常记录（孩子做过什么不能丢），但不进掌握度、不推进 SM-2。
     */
    const todayCounts = actor === "child" ? state.repo.todayAttemptCounts(body.learnerId, body.questionId) : { correct: 0, wrong: 0 };
    const repeatSameDay = actor === "child" && (result.correct ? todayCounts.correct > 0 : todayCounts.wrong > 0);
    /*
     * 探针的来源由**服务端**按队列项判定，不信客户端传的 source。
     * 早先前端从没传过 source=probe，于是宪法第 4 条的证据通道从来没收到过东西。
     * 反过来，客户端自称 probe 但没有对应的探针队列项，就退回 daily——
     * 不然谁都能把一条普通作答伪装成"探查过前置知识"。
     */
    const queueKind = body.queueItemId ? state.repo.getQueueItem(body.queueItemId)?.kind : undefined;
    const source: typeof body.source =
      queueKind === "probe" ? "probe" : body.source === "probe" ? "daily" : body.source;
    const attempt = state.repo.insertAttempt({
      learnerId: body.learnerId,
      questionId: body.questionId,
      answer: body.answer,
      correct: result.correct,
      hintLevelUsed: body.hintLevelUsed as 0 | 1 | 2 | 3,
      source,
      durationS: body.durationS,
      needsReview: pending || !result.hasJudge || untrustedQuestion,
      verification: result.verification,
      actor,
    });
    if (body.queueItemId) state.repo.consumeQueueItem(body.queueItemId);

    /*
     * 一条证据到底算不算数，**只在这里判一次**。
     *
     * 不算数的情形：判不准（pending，等家长裁决）、只有 AI 判断（ai_unverified）、
     * 题目自己的参考答案没人核对过（untrustedQuestion）、家长试做（actor=parent）、
     * 以及同题同日的重复作答（repeatSameDay）。
     * 这些都不进掌握度、不推进 SM-2、不回填探针证据——
     * 否则"不算数的证据"会从侧门把知识推动了，只是看不见而已。
     */
    const counted =
      !pending && !untrustedQuestion && countsTowardMastery(attempt.verification) && actor === "child" && !repeatSameDay;
    const masteryChanges: { nodeId: string; p: number; band: string }[] = [];
    if (counted) {
      // 作答前看过这道题的解析：那一次答对是回忆，不是理解，增益打折（扣分照旧）
      const viewed = state.repo.viewedAnalysisBefore(body.learnerId, body.questionId, attempt.at);
      const stats = loadEvidenceStats(state.repo, state.questions, body.learnerId);
      question.nodeIds.forEach((nodeId, index) => {
        const current = state.repo.getMastery(body.learnerId, nodeId);
        const next = applyAttempt(
          current ? { p: current.p, evidenceN: current.evidenceN } : undefined,
          result.correct,
          body.hintLevelUsed as 0 | 1 | 2 | 3,
          // 主节点满额；挂在这道题上的其它节点只沾一半（一题多节点不能都满分）
          (viewed ? MASTERY_PARAMS.afterAnalysisGainFactor : 1) * (index === 0 ? 1 : 0.5),
        );
        const row = {
          learnerId: body.learnerId,
          nodeId,
          p: next.p,
          evidenceN: next.evidenceN,
          lastEvidenceAt: new Date().toISOString(),
        };
        state.repo.upsertMastery(row);
        masteryChanges.push({ nodeId, p: next.p, band: masteryBand(next.p, next.evidenceN, stats.get(nodeId)) });
      });
    }
    state.repo.appendEvent(body.learnerId, "attempt", {
      attemptId: attempt.id,
      questionId: body.questionId,
      correct: result.correct,
      method: result.method,
      hintLevelUsed: body.hintLevelUsed,
      source,
      repeatSameDay,
      actor,
    });

    // 探针作答回填归因证据（宪法第 4 条：探针是证据，图遍历只是假设）
    if (source === "probe" && counted) {
      backfillProbeEvidence(state.repo, body.learnerId, question, result.correct);
    }

    // SM-2 推进（复习卡作答）；日常答错自动入复习（宪法第 3 条）
    let review: { stage: number; mastered: boolean; nextReviewAt: string | null } | undefined;
    if (body.reviewCardId && counted) {
      review = advanceReviewCard(state.repo, body.reviewCardId, result.correct);
    } else if (counted && !result.correct && source === "daily") {
      ensureReviewCard(state.repo, body.learnerId, body.questionId);
    }

    return c.json({
      attemptId: attempt.id,
      correct: result.correct,
      method: result.method,
      needsReview: pending || !result.hasJudge || untrustedQuestion,
      // 让界面能如实标注"AI 判断，未验证"，而不是悄悄给一个对勾
      verification: attempt.verification,
      countedTowardMastery: counted,
      // 家长试做、同题重交：都不算证据，界面该说出来，而不是装作无事发生
      trial: actor === "parent",
      repeat: repeatSameDay,
      /*
       * 值得请他讲一讲思路的时刻：第一次见这道题就零提示做对了。
       * 这不是考试，是让他把自己的想法说出来——那句话是元认知证据，
       * 不进掌握度（自由表达判不了对错），但家长看得到他会不会讲。
       */
      askWhy: counted && result.correct && !seenBefore && body.hintLevelUsed === 0 && actor === "child",
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

  // 元认知通道：错后先猜、答对后说说怎么想的（ai_unverified，不进掌握度）
  app.post("/reflection", async (c) => {
    const parsed = ReflectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId) ?? parsed.data.learnerId;
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);
    if (!state.questions.byId.get(parsed.data.questionId)) return c.json({ error: "题目不存在" }, 404);
    const text = parsed.data.text?.trim();
    if (text) {
      // 自由输入过一遍安检：孩子写下的话会进家长可见的记录，也可能被检索
      const screen = screenLearnerInput(state.repo, learnerId, text);
      if (screen.blocked) return c.json({ error: screen.reply, safety: screen.verdict }, 422);
    }
    if (!text && !parsed.data.guess) return c.json({ error: "写一句或者选一个" }, 400);
    state.repo.appendEvent(learnerId, "reflection", {
      questionId: parsed.data.questionId,
      attemptId: parsed.data.attemptId,
      kind: parsed.data.kind,
      guess: parsed.data.guess,
      text: text?.slice(0, 500),
      // 明确写下来：这是孩子自己的话，判不了对错，别让下游把它当证据
      verification: "ai_unverified",
    });
    return c.json({ ok: true });
  });

  app.post("/hint", async (c) => {
    const parsed = HintSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const { questionId, level, lastWrongAnswer } = parsed.data;
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId) ?? parsed.data.learnerId;
    const question = state.questions.byId.get(questionId);
    if (!question) return c.json({ error: "题目不存在" }, 404);
    /*
     * 提示要一级一级来（服务端记账，不信客户端自报的层级）。
     * 否则客户端可以直接把 level:3 发给「第一个式子」那一级——
     * 对一步题，那一句就是全部解法。
     */
    const maxLevel = state.repo.maxHintLevel(learnerId, questionId);
    if (level > maxLevel + 1) {
      return c.json({ error: "提示要一级一级来：先把这一级用起来，再要下一级。" }, 409);
    }
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
