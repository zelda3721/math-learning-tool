import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SceneSpecSchema } from "@mathtutor/schema";
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
    /** 模式 A（web，默认）：plan-only 秒级动画；模式 B（video）：Manim 高级成片 */
    mode: z.enum(["web", "video"]).default("web"),
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
    specUrl: e.specUrl,
    videoUrl: e.videoUrl,
    subtitleUrl: e.subtitleUrl,
    quality: e.quality,
  };
}

/** 模式 A：plan-only 调引擎出 SceneSpec，存 data/specs/，登记 explanations */
async function runWebModeJob(
  state: AppState,
  jobId: string,
  body: { learnerId?: string; questionId?: string; focusNodeId?: string; misconceptionId?: string; mistakeId?: string },
  payload: { problem: string; grade: string; learner_id?: string; extra_directives?: string },
): Promise<void> {
  const repo = state.repo;
  const fetchImpl = state.engineFetch ?? fetch;
  try {
    const resp = await fetchImpl(`${state.config.engineUrl}/api/v1/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) throw new Error(`引擎 plan 响应 ${resp.status}`);
    const result = (await resp.json()) as {
      status: string;
      plan_id: string;
      scene_spec?: unknown;
      error?: string;
    };
    if (result.status !== "ok" || !result.scene_spec) {
      repo.failExplainJob(jobId, result.error ?? "plan-only 未产出 SceneSpec");
      return;
    }
    const parsed = SceneSpecSchema.safeParse(result.scene_spec);
    if (!parsed.success) {
      repo.failExplainJob(jobId, `SceneSpec 校验失败: ${parsed.error.issues[0]?.message}`);
      return;
    }
    // 确定性 spec 结构检查（宪法第 5 条 web 侧门槛）：有对象、有拍子才算合格讲解
    const spec = parsed.data;
    const structuralWarnings: string[] = [];
    if (spec.visual_objects.length === 0) structuralWarnings.push("无可视对象");
    if (spec.scenes.length === 0) structuralWarnings.push("无讲解拍子");
    if (spec.visual_objects.length === 0 && spec.scenes.length === 0) {
      repo.failExplainJob(jobId, "SceneSpec 为空（无对象且无拍子）");
      return;
    }
    const specId = randomUUID();
    const specsDir = path.join(state.config.dataDir, "specs");
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(path.join(specsDir, `${specId}.json`), JSON.stringify(spec, null, 2), "utf8");

    const explanationId = randomUUID();
    repo.insertExplanation({
      id: explanationId,
      questionId: body.questionId,
      focusNodeIds: body.focusNodeId
        ? [body.focusNodeId]
        : ((body.questionId ? state.questions.byId.get(body.questionId)?.nodeIds : undefined) ?? []),
      engineSessionId: result.plan_id,
      mode: "web",
      specUrl: `/api/v1/explain/specs/${specId}`,
      quality: structuralWarnings.length ? "acceptable" : "good",
      contractVersion: state.contract?.contract_version ?? "unknown",
    });
    if (body.mistakeId) repo.linkMistakeExplanation(body.mistakeId, explanationId);
    repo.finishExplainJob(jobId, explanationId);
  } catch (err) {
    repo.failExplainJob(jobId, String(err));
  }
}

export function explainRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = ExplainSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    const body = parsed.data;
    const fallback = buildFallback(state, body);

    // 1) 缓存命中（同题优先，其次同根因节点；按模式命中）
    const cached = state.repo.findExplanation(body.questionId, body.focusNodeId, body.mode);
    if (cached && (cached.videoUrl || cached.specUrl)) {
      if (body.mistakeId) state.repo.linkMistakeExplanation(body.mistakeId, cached.id);
      return c.json({ status: "ready", explanation: explanationView(cached), fallback });
    }

    // 2) 引擎离线：只有图文兜底（诚实降级）
    if (!state.contract) {
      return c.json({ status: "offline", fallback, message: "讲解引擎离线，先看文字讲解" });
    }

    // 3) 同题同模式 running 任务去重
    if (body.questionId) {
      const running = state.repo.runningExplainJobForQuestion(body.questionId, body.mode);
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
      mode: body.mode,
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
    // 模式 A（web 默认）：plan-only 出 SceneSpec，秒级~分钟级、无渲染
    if (body.mode === "web") {
      void runWebModeJob(state, jobId, body, payload);
      return c.json({ status: "generating", jobId, mode: "web", fallback }, 202);
    }

    // 模式 B（video 高级）：Manim 完整五阶段
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

  // SceneSpec 产物（web 模式讲解数据；播放器 fetch 后本地渲染）
  app.get("/specs/:id", (c) => {
    const id = c.req.param("id").replace(/[^\w-]/g, "");
    const file = path.join(state.config.dataDir, "specs", `${id}.json`);
    if (!existsSync(file)) return c.json({ error: "spec 不存在" }, 404);
    return c.body(readFileSync(file, "utf8"), 200, { "content-type": "application/json" });
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
