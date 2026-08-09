import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppState } from "../app.js";
import { composeDirectives, generateViaEngine } from "./engine.js";

/**
 * P2 讲解管线（模式 B · Manim）：缓存命中直接返回；未命中建生成任务，
 * 图文兜底任何分支都即时可用（宪法：不空手失败）。
 */

const ExplainSchema = z
  .object({
    learnerId: z.string().optional(),
    questionId: z.string().optional(),
    focusNodeId: z.string().optional(),
    misconceptionId: z.string().optional(),
    mistakeId: z.string().optional(),
  })
  .refine((v) => v.questionId || v.focusNodeId, { message: "需要 questionId 或 focusNodeId" });

interface Fallback {
  rootNode?: { name: string; whatIsIt?: string; why?: string };
  chainNames?: string[];
  misconceptionDesc?: string;
  analysis?: string;
}

/** 图文兜底：归因链 + 节点讲解 + 常见坑 + 题目解析（当场可读，不等视频） */
function buildFallback(
  state: AppState,
  args: { questionId?: string; focusNodeId?: string; misconceptionId?: string; mistakeId?: string },
): Fallback {
  const fallback: Fallback = {};
  const mistake = args.mistakeId ? state.repo.getMistake(args.mistakeId) : undefined;
  const question = args.questionId ? state.questions.byId.get(args.questionId) : undefined;
  const focusNodeId = args.focusNodeId ?? mistake?.rootNodeId ?? question?.nodeIds[0];
  const node = focusNodeId ? state.knowledge.index.getNode(focusNodeId) : undefined;
  if (node) {
    fallback.rootNode = { name: node.name, whatIsIt: node.whatIsIt, why: node.why };
    const misconceptionId = args.misconceptionId ?? mistake?.misconceptionId;
    fallback.misconceptionDesc = node.misconceptions.find((m) => m.id === misconceptionId)?.desc;
  }
  if (mistake) {
    fallback.chainNames = mistake.chain.map((id) => state.knowledge.index.getNode(id)?.name ?? id);
  }
  fallback.analysis = question?.analysis;
  return fallback;
}

function explanationView(e: NonNullable<ReturnType<AppState["repo"]["getExplanation"]>>) {
  return {
    id: e.id,
    questionId: e.questionId,
    focusNodeIds: e.focusNodeIds,
    mode: e.mode,
    videoUrl: e.videoUrl,
    subtitleUrl: e.subtitleUrl,
    quality: e.quality,
  };
}

export function explainRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = ExplainSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    const body = parsed.data;
    const fallback = buildFallback(state, body);

    // 1) 缓存命中（同题优先，其次同根因节点）
    const cached = state.repo.findExplanation(body.questionId, body.focusNodeId);
    if (cached?.videoUrl) {
      if (body.mistakeId) state.repo.linkMistakeExplanation(body.mistakeId, cached.id);
      return c.json({ status: "ready", explanation: explanationView(cached), fallback });
    }

    // 2) 引擎离线：只有图文兜底（诚实降级）
    if (!state.contract) {
      return c.json({ status: "offline", fallback, message: "讲解引擎离线，先看文字讲解" });
    }

    // 3) 同题 running 任务去重
    if (body.questionId) {
      const running = state.repo.runningExplainJobForQuestion(body.questionId);
      if (running) return c.json({ status: "generating", jobId: running, fallback }, 202);
    }

    // 4) 建任务，异步调引擎（生成队列首版只排当天错题——即本请求）
    const question = body.questionId ? state.questions.byId.get(body.questionId) : undefined;
    const focusNode = body.focusNodeId ? state.knowledge.index.getNode(body.focusNodeId) : undefined;
    if (!question && !focusNode) return c.json({ error: "题目/节点不存在" }, 404);

    const learner = body.learnerId ? state.repo.getLearner(body.learnerId) : undefined;
    const jobId = state.repo.createExplainJob({
      learnerId: body.learnerId,
      questionId: body.questionId,
      focusNodeIds: body.focusNodeId ? [body.focusNodeId] : (question?.nodeIds ?? []),
    });
    const payload = {
      problem: question
        ? question.stem
        : `请讲解知识点：${focusNode!.name}——${focusNode!.whatIsIt ?? focusNode!.summary}`,
      grade: learner?.level ?? question?.level ?? "elementary_upper",
      learner_id: body.learnerId,
      extra_directives: composeDirectives({
        knowledge: state.knowledge,
        question,
        focusNodeId: body.focusNodeId,
        misconceptionId: body.misconceptionId,
      }),
    };
    const repo = state.repo;
    const contractVersion = state.contract.contract_version;
    void generateViaEngine(state.config.engineUrl, payload, state.engineFetch ?? fetch)
      .then((result) => {
        if (result.status === "ok" && result.videoUrl) {
          const explanationId = randomUUID();
          repo.insertExplanation({
            id: explanationId,
            questionId: body.questionId,
            focusNodeIds: body.focusNodeId ? [body.focusNodeId] : (question?.nodeIds ?? []),
            engineSessionId: result.sessionId ?? "unknown",
            mode: "video",
            videoUrl: result.videoUrl,
            // 分级交付：done 文案带「保底/质量提示」→ acceptable，否则 good
            quality: /保底|质量提示|质量警告/.test(result.doneText ?? "") ? "acceptable" : "good",
            contractVersion,
          });
          if (body.mistakeId) repo.linkMistakeExplanation(body.mistakeId, explanationId);
          repo.finishExplainJob(jobId, explanationId);
        } else {
          repo.failExplainJob(jobId, result.doneText ?? `引擎返回 ${result.status}`);
        }
      })
      .catch((err) => repo.failExplainJob(jobId, String(err)));

    return c.json({ status: "generating", jobId, fallback }, 202);
  });

  app.get("/jobs/:id", (c) => {
    const job = state.repo.getExplainJob(c.req.param("id"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    const explanation = job.explanationId ? state.repo.getExplanation(job.explanationId) : undefined;
    return c.json({
      status: job.status,
      explanation: explanation ? explanationView(explanation) : undefined,
      error: job.error,
    });
  });

  return app;
}
