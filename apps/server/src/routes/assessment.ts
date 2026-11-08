import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Question } from "@mathtutor/schema";
import { effectiveLearnerId, type AppState } from "../app.js";
import type { AuthUser } from "../auth.js";
import { budgetBlockedPayload } from "../chatBudget.js";
import { getSubjectRegistry, judgeAnswer } from "../subjects.js";
import { moduleBlockedBody, moduleEnabled } from "../modules.js";
import { loadVocabulary } from "../vocabulary.js";
import { loadReading } from "../reading.js";
import {
  ASSESSMENT_KINDS,
  ASSESSMENT_PENDING_EVENT,
  assessmentItemsOf,
  assessmentSubjectOf,
  buildAssessment,
  buildEnglishAssessment,
  englishItemView,
  englishNodeIdsOf,
  englishReference,
  judgeEnglishItem,
  latestFinishedAssessment,
  nextAssessment,
  parseEnglishItemId,
  summarizeAssessment,
  type AssessmentKind,
  type AssessmentSubject,
} from "../assessment.js";

/**
 * 阶段测评接口（前测 / 后测 / 保持率）。
 *
 * 和练习故意长得不一样：
 * - **没有提示**：测评里点不出提示阶梯，答不出来就是答不出来；
 * - **作答时不回对错**：交卷才给结果，否则后面的题会被前一道的反馈带跑；
 * - **不写 attempts / 掌握度**：单独记账（见 assessment.ts 的三条口径）。
 *
 * 再加几道闸，都是"别让数字失真"：
 * - 只有孩子本人能做（家长在孩子页面点开测评，成绩会记到孩子名下）；
 * - 按排期来：没到时间不开、同一档只做一次；
 * - 一道题只记第一次作答（改答案等于在测评里刷题）；
 * - 至少答一半才能交卷（答两道就交，这份卷子什么也说明不了）。
 */

const StartSchema = z.object({
  learnerId: z.string().optional(),
  kind: z.enum(["pre", "post", "retention"]),
  subject: z.enum(["math", "english"]).optional(),
  count: z.number().int().min(4).max(12).optional(),
});

const AnswerSchema = z.object({
  learnerId: z.string().optional(),
  questionId: z.string(),
  answer: z.string().max(500),
});

const KIND_LABEL: Record<AssessmentKind, string> = { pre: "前测", post: "后测", retention: "保持率检查" };

/**
 * 下发给孩子的数学题视图：与练习的 sanitize 同一套白名单。
 * 双语题的英文题面、作答语言、配图都是题面的一部分（几何题没图读不懂）；
 * answer / analysis / analysisImage 绝不下发。
 */
function sanitize(q: Question) {
  return {
    id: q.id,
    stem: q.stem,
    stemEn: q.stemEn,
    answerLang: q.answerLang,
    options: q.options,
    answerType: q.answerType,
    difficulty: q.difficulty,
    level: q.level,
    nodeIds: q.nodeIds,
    figureImage: q.figureImage,
    figure: q.figure,
  };
}

/**
 * 家长不能替孩子做测评。effectiveLearnerId 对家长会话按请求值放行，
 * 所以家长在孩子页面点开测评，成绩会原样记到孩子名下——这里显式挡住。
 */
function isParent(c: Context): boolean {
  return (c.get("user") as AuthUser | undefined)?.role === "parent";
}

const PARENT_BLOCKED = { error: "测评要孩子本人做：家长代做的成绩会记在孩子名下，前后对比就不准了。", code: "parent-forbidden" };

export function assessmentRoutes(state: AppState): Hono {
  const app = new Hono();

  // 词表与读物每次现读：文件很小，且判卷要和出题看到同一份内容
  const english = () => ({ vocabulary: loadVocabulary(), reading: loadReading() });

  /** 现在该不该做测评、做哪一档（孩子端和规划都能读） */
  app.get("/next", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const subject: AssessmentSubject = c.req.query("subject") === "english" ? "english" : "math";
    return c.json({ subject, suggestion: nextAssessment(state.repo, learnerId, new Date(), subject) });
  });

  app.post("/start", async (c) => {
    if (isParent(c)) return c.json(PARENT_BLOCKED, 403);
    const parsed = StartSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const subject: AssessmentSubject = parsed.data.subject ?? "math";
    if (subject === "english" && !moduleEnabled(state.repo, learnerId, "english")) {
      return c.json(moduleBlockedBody("english"), 403);
    }
    const blocked = budgetBlockedPayload(state.repo, learnerId);
    if (blocked) return c.json(blocked, 429);

    const kind = parsed.data.kind as AssessmentKind;
    if (!ASSESSMENT_KINDS.includes(kind)) return c.json({ error: "没有这一档测评" }, 400);

    // ---- 排期闸：同一档只做一次；没轮到 / 没到时间都不开 ----
    if (latestFinishedAssessment(state.repo, learnerId, kind, subject)) {
      return c.json({ error: `${KIND_LABEL[kind]}已经做过了。同一档只做一次，重复做测的就是"刷测评"了。` }, 409);
    }
    const suggestion = nextAssessment(state.repo, learnerId, new Date(), subject);
    if (!suggestion || suggestion.kind !== kind) {
      return c.json(
        {
          error: suggestion ? `现在还轮不到${KIND_LABEL[kind]}，先做${KIND_LABEL[suggestion.kind]}。` : "这一轮测评都做完了。",
          suggestion,
        },
        409,
      );
    }
    if (suggestion.dueAt) {
      return c.json({ error: `${KIND_LABEL[kind]}还没到时间：${suggestion.why}`, dueAt: suggestion.dueAt, suggestion }, 409);
    }

    // ---- 续做：开过没交卷的同档测评直接接着做，不另开一份（另开会白白消耗没见过的题） ----
    const open = state.repo
      .listAssessments(learnerId, 50)
      .find((a) => !a.finishedAt && a.kind === kind && assessmentSubjectOf(a) === subject);
    if (open) {
      const items = state.repo.listAssessmentItems(open.id);
      const content = subject === "english" ? english() : null;
      const questions = items
        .map((i) =>
          content
            ? englishItemView(i.questionId, content.vocabulary, content.reading)
            : (() => {
                const q = state.questions.byId.get(i.questionId);
                return q ? sanitize(q) : null;
              })(),
        )
        .filter((q) => q !== null);
      return c.json({
        id: open.id,
        kind,
        subject,
        resumed: true,
        answeredIds: items.filter((i) => i.answeredAt).map((i) => i.questionId),
        questions,
        note: "接着上次没做完的这份测评做。已经答过的题不用再答。",
      });
    }

    let questionIds: string[];
    let scope: string[];
    let reused: boolean;
    let questions: unknown[];
    if (subject === "english") {
      const { vocabulary, reading } = english();
      const built = buildEnglishAssessment(state.repo, learnerId, vocabulary, reading);
      if (built.items.length === 0) return c.json({ error: "词表和读物里还没有可用于测评的内容" }, 503);
      questionIds = built.items.map((i) => i.id);
      scope = built.scope;
      reused = built.reused;
      questions = built.items;
    } else {
      const built = buildAssessment(state.questions, state.repo, learnerId, { kind, count: parsed.data.count });
      if (built.questions.length === 0) return c.json({ error: "题库里还没有可用于测评的题" }, 503);
      questionIds = built.questions.map((q) => q.id);
      scope = built.scope;
      reused = built.reused;
      questions = built.questions.map(sanitize);
    }

    const id = state.repo.createAssessment(learnerId, kind, scope, questionIds);
    state.repo.appendEvent(learnerId, "assessment_start", {
      assessmentId: id,
      kind,
      subject,
      scope,
      questions: questionIds.length,
      reused,
    });
    const fromPre = kind !== "pre" ? "题目覆盖的内容和前测一样，但题都换了新的，" : "";
    return c.json({
      id,
      kind,
      subject,
      reused,
      questions,
      note: reused
        ? `${fromPre}不过没见过的题不够了，有几道是以前做过（或在测评里见过答案）的——只能这样凑，如实标出来，这几道的对错参考意义小一些。`
        : `${fromPre}这些题你都没做过。没有提示，答不出来也没关系，这是看看你现在会到哪儿。`,
    });
  });

  app.post("/:id/answer", async (c) => {
    if (isParent(c)) return c.json(PARENT_BLOCKED, 403);
    const parsed = AnswerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    const assessment = state.repo.getAssessment(c.req.param("id"));
    if (!assessment || assessment.learnerId !== learnerId) return c.json({ error: "测评不存在" }, 404);
    // 410 不是 409：前端把 409 当"这题已经记下了"往下走；交卷了是另一回事，要去看结果
    if (assessment.finishedAt) return c.json({ error: "这份测评已经交卷了", code: "finished" }, 410);
    const item = state.repo.listAssessmentItems(assessment.id).find((i) => i.questionId === parsed.data.questionId);
    if (!item) return c.json({ error: "这道题不在这份测评里" }, 404);
    // 只记第一次作答：能改答案，测评就成了"试到对为止"
    if (item.answeredAt) return c.json({ error: "这道题已经答过了，测评里每道题只记第一次的回答。" }, 409);

    if (parseEnglishItemId(item.questionId)) {
      // 卷子开着的时候家长关了英语：照样拦（开卷时查过一次不等于一直开着）
      if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
      const { vocabulary, reading } = english();
      const verdict = judgeEnglishItem(item.questionId, parsed.data.answer, vocabulary, reading);
      if (!verdict) return c.json({ error: "题目不存在" }, 404);
      if (!state.repo.answerAssessmentItem(assessment.id, item.questionId, parsed.data.answer, verdict.correct)) {
        return c.json({ error: "这道题已经答过了，测评里每道题只记第一次的回答。" }, 409);
      }
      return c.json({ recorded: true, method: "exact" });
    }

    const question = state.questions.byId.get(item.questionId);
    if (!question) return c.json({ error: "题目不存在" }, 404);
    const registry = state.subjects ?? getSubjectRegistry();
    const result = await judgeAnswer(registry, state.knowledge, question, parsed.data.answer);
    const pendingJudge = result.method === "pending";
    // 判卷要等（语义判卷可能好几秒）：写入时再守一次"只记第一次"，并发的第二次拿 409
    if (!state.repo.answerAssessmentItem(assessment.id, item.questionId, parsed.data.answer, pendingJudge ? null : result.correct)) {
      return c.json({ error: "这道题已经答过了，测评里每道题只记第一次的回答。" }, 409);
    }
    if (pendingJudge) {
      // 判不准：库里存 NULL；另记一条留痕，方便家长端追溯（旧库存的是 0，也靠它还原）
      state.repo.appendEvent(learnerId, ASSESSMENT_PENDING_EVENT, {
        assessmentId: assessment.id,
        questionId: item.questionId,
      });
    }
    // 作答过程中不回对错：只说"记下了"，免得后面的题被前一道的反馈带跑
    return c.json({ recorded: true, method: result.method });
  });

  app.post("/:id/finish", async (c) => {
    if (isParent(c)) return c.json(PARENT_BLOCKED, 403);
    const parsed = z
      .object({ learnerId: z.string().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    const assessment = state.repo.getAssessment(c.req.param("id"));
    if (!assessment || assessment.learnerId !== learnerId) return c.json({ error: "测评不存在" }, 404);

    let items = assessmentItemsOf(state.repo, learnerId, assessment.id);
    if (!assessment.finishedAt) {
      const responded = items.filter((i) => i.answeredAt !== null).length;
      const need = Math.ceil(items.length / 2);
      if (responded < need) {
        return c.json(
          {
            error: `才答了 ${responded} / ${items.length} 道，至少答完一半（${need} 道）再交卷——答得太少，这份测评看不出你会到哪儿。不会的题可以直接写"不会"。`,
            responded,
            need,
          },
          409,
        );
      }
      state.repo.finishAssessment(assessment.id);
      items = assessmentItemsOf(state.repo, learnerId, assessment.id);
    }

    const isEnglish = assessmentSubjectOf(assessment) === "english";
    const content = isEnglish ? english() : null;
    const summary = summarizeAssessment(
      assessment,
      items,
      (qid) =>
        content ? englishReference(qid, content.vocabulary, content.reading) : (state.questions.byId.get(qid)?.answer ?? ""),
      (qid) => (isEnglish ? englishNodeIdsOf(qid) : (state.questions.byId.get(qid)?.nodeIds ?? [])),
    );
    state.repo.appendEvent(learnerId, "assessment_finish", {
      assessmentId: assessment.id,
      kind: assessment.kind,
      subject: isEnglish ? "english" : "math",
      answered: summary.answered,
      correct: summary.correct,
      pending: summary.pending,
      // 测评数字单独记账；它不是掌握度证据，也不写 attempts
      verification: "reference",
    });
    return c.json({ summary });
  });

  return app;
}
