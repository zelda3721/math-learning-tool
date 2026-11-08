import { Hono } from "hono";
import { z } from "zod";
import { effectiveLearnerId, type AppState } from "../app.js";
import { budgetBlockedPayload } from "../chatBudget.js";
import { getSubjectRegistry, judgeAnswer } from "../subjects.js";
import {
  ASSESSMENT_KINDS,
  buildAssessment,
  nextAssessment,
  summarizeAssessment,
  type AssessmentKind,
} from "../assessment.js";

/**
 * 阶段测评接口（前测 / 后测 / 保持率）。
 *
 * 和练习故意长得不一样：
 * - **没有提示**：测评里点不出提示阶梯，答不出来就是答不出来；
 * - **作答时不回对错**：交卷才给结果，否则后面的题会被前一道的反馈带跑；
 * - **不写 attempts / 掌握度**：单独记账（见 assessment.ts 的三条口径）。
 */

const StartSchema = z.object({
  learnerId: z.string().optional(),
  kind: z.enum(["pre", "post", "retention"]),
  count: z.number().int().min(4).max(12).optional(),
});

const AnswerSchema = z.object({
  learnerId: z.string().optional(),
  questionId: z.string(),
  answer: z.string().max(500),
});

function sanitize(q: { id: string; stem: string; options?: string[]; answerType: string; nodeIds: string[] }) {
  return { id: q.id, stem: q.stem, options: q.options, answerType: q.answerType, nodeIds: q.nodeIds };
}

export function assessmentRoutes(state: AppState): Hono {
  const app = new Hono();

  /** 现在该不该做测评、做哪一档（孩子端和规划都能读） */
  app.get("/next", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    return c.json({ suggestion: nextAssessment(state.repo, learnerId) });
  });

  app.post("/start", async (c) => {
    const parsed = StartSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    const blocked = budgetBlockedPayload(state.repo, learnerId);
    if (blocked) return c.json(blocked, 429);

    const kind = parsed.data.kind as AssessmentKind;
    if (!ASSESSMENT_KINDS.includes(kind)) return c.json({ error: "没有这一档测评" }, 400);
    const built = buildAssessment(state.questions, state.repo, learnerId, { kind, count: parsed.data.count });
    if (built.questions.length === 0) return c.json({ error: "题库里还没有可用于测评的题" }, 503);

    const id = state.repo.createAssessment(
      learnerId,
      kind,
      built.scope,
      built.questions.map((q) => q.id),
    );
    state.repo.appendEvent(learnerId, "assessment_start", {
      assessmentId: id,
      kind,
      scope: built.scope,
      questions: built.questions.length,
      reused: built.reused,
    });
    return c.json({
      id,
      kind,
      reused: built.reused,
      questions: built.questions.map(sanitize),
      note: built.reused
        ? "这次有几道题以前做过——题不够新题时只能这样，如实标出来。"
        : "这些题你都没做过。没有提示，答不出来也没关系，这是看看你现在会到哪儿。",
    });
  });

  app.post("/:id/answer", async (c) => {
    const parsed = AnswerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    const assessment = state.repo.getAssessment(c.req.param("id"));
    if (!assessment || assessment.learnerId !== learnerId) return c.json({ error: "测评不存在" }, 404);
    if (assessment.finishedAt) return c.json({ error: "这份测评已经交卷了" }, 409);
    const item = state.repo.listAssessmentItems(assessment.id).find((i) => i.questionId === parsed.data.questionId);
    if (!item) return c.json({ error: "这道题不在这份测评里" }, 404);

    const question = state.questions.byId.get(item.questionId);
    if (!question) return c.json({ error: "题目不存在" }, 404);
    const registry = state.subjects ?? getSubjectRegistry();
    const result = await judgeAnswer(registry, state.knowledge, question, parsed.data.answer);
    state.repo.answerAssessmentItem(assessment.id, item.questionId, parsed.data.answer, result.correct);
    // 作答过程中不回对错：只说"记下了"，免得后面的题被前一道的反馈带跑
    return c.json({ recorded: true, method: result.method });
  });

  app.post("/:id/finish", async (c) => {
    const parsed = z
      .object({ learnerId: z.string().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    const assessment = state.repo.getAssessment(c.req.param("id"));
    if (!assessment || assessment.learnerId !== learnerId) return c.json({ error: "测评不存在" }, 404);

    if (!assessment.finishedAt) state.repo.finishAssessment(assessment.id);
    const items = state.repo.listAssessmentItems(assessment.id);
    const summary = summarizeAssessment(
      assessment,
      items.map((i) => ({ questionId: i.questionId, correct: i.correct })),
      (qid) => state.questions.byId.get(qid)?.answer ?? "",
      (qid) => state.questions.byId.get(qid)?.nodeIds ?? [],
    );
    state.repo.appendEvent(learnerId, "assessment_finish", {
      assessmentId: assessment.id,
      kind: assessment.kind,
      answered: summary.answered,
      correct: summary.correct,
      // 测评数字单独记账；它不是掌握度证据，也不写 attempts
      verification: "reference",
    });
    return c.json({ summary });
  });

  return app;
}
