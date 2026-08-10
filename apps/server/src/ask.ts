import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EducationLevelSchema, QuestionSchema, SceneSpecSchema, type Question } from "@mathtutor/schema";
import { matchOffline, matchProblemTypesOffline } from "@mathtutor/knowledge";
import { effectiveLearnerId, type AppState } from "./app.js";
import { appendQuestions, contentHashOf } from "./questions.js";
import { expressionsEquivalent, normalizeText, parseNumeric } from "./grading.js";
import { composeDirectives } from "./explain/engine.js";
import { groundingSourceOf } from "./explain/grounding.js";

/**
 * P6 自由提问（题库外的题）——**不是答案机器**：
 * 一道自由输入的题被转成一道临时题目，然后复用整套既有练习纪律
 * （先自己作答 → 判卷 → L1→L3 提示 → 仍错才讲解 → 变式题点亮）。
 *
 * 关键点：
 * ① 引擎 POST /api/v1/plan 的 solution_answer 是 Solve→Verify 验证过的，可当判卷依据；
 *    但仍标 status='extracted' 进家长抽检队列——LLM 解出的答案必须家长可复核。
 * ② 题目 id 用 `free-<stem hash>`，与 explain 的自由文本伪 id 同源，
 *    plan 阶段算出的 scene_spec 顺手登记成 web 讲解 → 后续 /explain 秒回。
 * ③ 入库到 asked-<learnerId> 批次文件 + store.reload()：
 *    孩子问过的题自动进入后续组卷/复习/变式供给。
 */

const AskSchema = z.object({
  learnerId: z.string().optional(),
  problem: z.string().min(4).max(500),
  grade: EducationLevelSchema.optional(),
});

/** 发给前端的题目视图：绝不包含 answer/analysis（与 practice 的 sanitize 同口径，独立实现避免跨模块耦合） */
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
    status: q.status,
  };
}

/** 自由题目的确定性 id：与 explain 的自由文本伪 id 完全一致（讲解缓存同键） */
export function askQuestionId(problem: string): string {
  return `free-${contentHashOf(problem, "")}`;
}

/**
 * 唯一数值答案：整个答案里只有一个数（可带单位/前缀/百分号/分数），
 * 才允许按 numeric 判卷——否则 parseNumeric 只取第一个数会误判
 * （"长8宽5周长26" 会被读成 8）。
 */
const SINGLE_NUMBER = /^[^\d]{0,12}-?\d+(?:\.\d+)?(?:\/\d+)?%?[^\d]{0,8}$/;

/**
 * 答案可判卷分级（宪法：判卷必须确定性，判不了就诚实进家长抽检）：
 * - 带变量的代数式（"2x+3"）先判表达式——parseNumeric 会误把它读成首个数字 2；
 * - 只含单个数值的答案（"26"、"26 厘米"、"3/4"、"x=4"）走 numeric；
 * - 文字/多数值/长篇答案两者都不适用 → steps（主观题，作答与讲解照常，判卷进家长队列）。
 */
export function classifyAnswer(raw: string): Question["answerType"] {
  const text = raw.trim();
  if (!text) return "steps";
  const algebraic = /[+\-*/^()]/.test(text) && /[a-zA-Z]/.test(text);
  if (algebraic && text.length <= 200 && expressionsEquivalent(text, text)) return "expression";
  if (SINGLE_NUMBER.test(normalizeText(text)) && parseNumeric(text) !== null) return "numeric";
  if (!algebraic && text.length <= 200 && /[0-9a-zA-Z]/.test(text) && expressionsEquivalent(text, text))
    return "expression";
  return "steps";
}

/** 缓存查找：同 id（同题干）> 同 contentHash > 同规范化题干（题库里已有的题优先用题库的验证答案） */
export function findAskedQuestion(state: AppState, problem: string): Question | undefined {
  const direct = state.questions.byId.get(askQuestionId(problem));
  if (direct) return direct;
  const stemHash = contentHashOf(problem, "");
  const norm = normalizeText(problem);
  return state.questions.all.find((q) => q.contentHash === stemHash || normalizeText(q.stem) === norm);
}

/**
 * SceneSpec 落盘（与 explain web 模式同一产物目录/取回端点/分级口径）：
 * 有对象、有拍子才算 good；缺一为 acceptable；全空不算讲解（不登记）。
 */
function persistSceneSpec(
  state: AppState,
  spec: unknown,
): { specUrl: string; quality: "good" | "acceptable" } | undefined {
  const parsed = SceneSpecSchema.safeParse(spec);
  if (!parsed.success) return undefined;
  const { visual_objects, scenes } = parsed.data;
  if (visual_objects.length === 0 && scenes.length === 0) return undefined;
  const specId = randomUUID();
  const specsDir = path.join(state.config.dataDir, "specs");
  mkdirSync(specsDir, { recursive: true });
  writeFileSync(path.join(specsDir, `${specId}.json`), JSON.stringify(parsed.data, null, 2), "utf8");
  return {
    specUrl: `/api/v1/explain/specs/${specId}`,
    quality: visual_objects.length && scenes.length ? "good" : "acceptable",
  };
}

interface PlanResult {
  status: string;
  plan_id?: string;
  scene_spec?: unknown;
  solution_answer?: string;
  solution_steps?: string[];
  error?: string;
}

/** 引擎 plan-only：几分钟量级，所以整段跑在任务里 */
async function callPlan(
  state: AppState,
  payload: { problem: string; grade: string; learner_id?: string; extra_directives?: string },
): Promise<PlanResult> {
  const fetchImpl = state.engineFetch ?? fetch;
  const resp = await fetchImpl(`${state.config.engineUrl}/api/v1/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  });
  if (!resp.ok) throw new Error(`引擎 plan 响应 ${resp.status}`);
  return (await resp.json()) as PlanResult;
}

export async function runAskJob(
  state: AppState,
  jobId: string,
  args: { learnerId?: string; problem: string; level: Question["level"] },
): Promise<void> {
  const repo = state.repo;
  const questionId = askQuestionId(args.problem);
  // 知识点定位先做（确定性、零成本）：既是入库坐标，也让导演知道该讲哪个概念
  const nodeIds = matchOffline(state.knowledge.index, args.problem, 1)
    .map((m) => m.id)
    .filter((id) => state.knowledge.index.nodeById.has(id));
  const problemTypeId = matchProblemTypesOffline(state.knowledge.problemTypes, args.problem, 1)[0]?.id;
  try {
    const result = await callPlan(state, {
      problem: args.problem,
      grade: args.level,
      learner_id: args.learnerId,
      extra_directives: composeDirectives({ knowledge: state.knowledge, focusNodeId: nodeIds[0] }),
    });
    if (result.status !== "ok") {
      repo.failAskJob(jobId, result.error ?? `引擎 plan 返回 ${result.status}`);
      return;
    }
    const steps = (result.solution_steps ?? []).map((s) => String(s).trim()).filter(Boolean);
    const answer = (result.solution_answer ?? "").trim() || (steps.length ? steps[steps.length - 1]! : "");
    if (!answer) {
      // 没有答案就没有判卷依据——诚实失败，绝不建一道判不了的题
      repo.failAskJob(jobId, result.error ?? "引擎未产出可判卷答案");
      return;
    }

    const candidate = QuestionSchema.safeParse({
      id: questionId,
      problemTypeId,
      nodeIds,
      level: args.level,
      stem: args.problem,
      answer,
      answerType: classifyAnswer(answer),
      analysis: steps.length ? steps.join("\n") : undefined,
      difficulty: 3,
      // 孩子自己带来的题（拍/输入的题库外题）——既有 role 里 'student' 最贴切，schema 无需改动
      source: { role: "student" as const },
      contentHash: contentHashOf(args.problem, answer),
      // LLM 解出的答案必须家长可复核 → 进抽检队列（/api/v1/ingest/questions?status=extracted）
      status: "extracted" as const,
    });
    if (!candidate.success) {
      repo.failAskJob(jobId, `题目 schema 校验失败: ${candidate.error.issues[0]?.message}`);
      return;
    }

    const batch = `asked-${args.learnerId ?? "shared"}`;
    const { written } = appendQuestions(state.config.dataDir, batch, [candidate.data], state.questions);
    if (written.length) state.questions.reload();
    // 内容重复（题库里已有同 stem+answer 的题）→ 用既有那道题，不重复建题
    const finalId =
      state.questions.byId.get(questionId)?.id ??
      state.questions.all.find((q) => q.contentHash === candidate.data.contentHash)?.id;
    if (!finalId) {
      repo.failAskJob(jobId, "题目入库失败（校验或去重后未落库）");
      return;
    }

    // plan 阶段已算出的 scene_spec 顺手登记为 web 讲解 → 讲解阶段秒回，不再调一次引擎
    if (state.contract && result.scene_spec) {
      const persisted = persistSceneSpec(state, result.scene_spec);
      if (persisted && !repo.findExplanation(finalId, undefined, "web")) {
        repo.insertExplanation({
          id: randomUUID(),
          questionId: finalId,
          focusNodeIds: state.questions.byId.get(finalId)?.nodeIds ?? nodeIds,
          engineSessionId: result.plan_id ?? "unknown",
          mode: "web",
          specUrl: persisted.specUrl,
          quality: persisted.quality,
          contractVersion: state.contract.contract_version,
          groundingSource: groundingSourceOf(result.scene_spec),
        });
      }
    }

    if (args.learnerId) {
      state.repo.appendEvent(args.learnerId, "attempt", {
        kind: "ask",
        questionId: finalId,
        answerType: candidate.data.answerType,
      });
    }
    repo.finishAskJob(jobId, finalId);
  } catch (err) {
    repo.failAskJob(jobId, String(err));
  }
}

export function askRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = AskSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    // 孩子只能给自己提问（请求里传别人的 learnerId 会被会话覆盖）
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (learnerId && !state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);
    const problem = parsed.data.problem.trim();
    if (problem.length < 4) return c.json({ error: "题目太短了，把题目完整写下来" }, 400);

    // ① 缓存：问过的题（或题库里已有的题）直接给回，不重复调引擎
    const cached = findAskedQuestion(state, problem);
    if (cached) return c.json({ status: "ready", isNew: false, question: sanitize(cached) });

    // ② 引擎离线：解不出答案就判不了卷——诚实拒绝，不给「看起来像答案」的东西
    if (!state.contract) {
      return c.json({ error: "讲解引擎离线，这道新题暂时收不了——先做今天的练习。" }, 503);
    }

    // ③ 同题正在生成：复用任务
    const questionId = askQuestionId(problem);
    const running = state.repo.runningAskJobForQuestion(questionId, learnerId);
    if (running) return c.json({ status: "generating", isNew: true, jobId: running, questionId }, 202);

    const learner = learnerId ? state.repo.getLearner(learnerId) : undefined;
    const level = parsed.data.grade ?? learner?.level ?? "elementary_upper";
    const jobId = state.repo.createAskJob({ learnerId, questionId, problem });
    void runAskJob(state, jobId, { learnerId, problem, level });
    return c.json({ status: "generating", isNew: true, jobId, questionId }, 202);
  });

  app.get("/jobs/:id", (c) => {
    const job = state.repo.getAskJob(c.req.param("id"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    // 归属：孩子只能看自己的提问任务
    if (job.learnerId && effectiveLearnerId(c, state, job.learnerId) !== job.learnerId) {
      return c.json({ error: "仅本人可查看" }, 403);
    }
    const question = job.status === "done" ? state.questions.byId.get(job.questionId) : undefined;
    return c.json({
      status: job.status,
      isNew: true,
      question: question ? sanitize(question) : undefined,
      error: job.error,
    });
  });

  return app;
}
