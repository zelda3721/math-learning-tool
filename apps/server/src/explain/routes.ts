import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EducationLevelSchema, SceneSpecSchema } from "@mathtutor/schema";
import { effectiveLearnerId, type AppState } from "../app.js";
import { contentHashOf } from "../questions.js";
import { composeDirectives, generateViaEngine } from "./engine.js";
import { groundingSourceOf } from "./grounding.js";

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
    /** 自由题目文本（讲解 tab 直接输入，不经题库）；与 questionId/focusNodeId 三选一 */
    problem: z.string().min(4).max(500).optional(),
    grade: EducationLevelSchema.optional(),
    /** 模式 A（web，默认）：plan-only 秒级动画；模式 B（video）：Manim 高级成片 */
    // web=SceneSpec 交给固定播放器（画不出假话，受图元词表限制）
    // web_html=模型直写自足页面（表达上限最高，靠引擎侧契约门禁把住真实性）
    // both=两条都生成：优先给模型那份，没过门禁就自动退回 SceneSpec 那份。
    //      孩子始终有得看，同时攒下两条路的对比语料（生成成本翻倍）。
    // 不传时用配置里的默认（EXPLAIN_WEB_MODE），这样可以整机切换而不用改前端
    mode: z.enum(["web", "web_html", "both", "video"]).optional(),
  })
  .refine((v) => v.questionId || v.focusNodeId || v.problem, {
    message: "需要 questionId、focusNodeId 或 problem",
  });

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
    htmlUrl: e.htmlUrl,
    videoUrl: e.videoUrl,
    subtitleUrl: e.subtitleUrl,
    quality: e.quality,
    feedbackLabel: e.feedbackLabel,
  };
}

/**
 * 同题的其它形态讲解。both 模式会同时产出模型直写与 SceneSpec 两份，
 * 不把另一份交给前端，人就没法把它们摆在一起比——而「哪个讲得更清楚」
 * 只有人能判断，门禁判不了。
 */
function alternativesOf(state: AppState, e: { id: string }) {
  return state.repo.siblingExplanations(e.id).map(explanationView);
}

type WebJobMode = "web" | "web_html" | "both";

interface WebJobBody {
  learnerId?: string;
  questionId?: string;
  focusNodeId?: string;
  misconceptionId?: string;
  mistakeId?: string;
}

/**
 * Web 讲解生成任务（三种模式共用一条链路）。
 *
 * - `web`      SceneSpec → 固定播放器渲染
 * - `web_html` 模型直写自足页面 → sandbox iframe 渲染
 * - `both`     两条都生成：**优先交付模型那份，没过门禁就自动退回 SceneSpec 那份**。
 *              孩子始终有得看，同时攒下两条路的对比语料（生成成本翻倍）。
 *
 * 网关只做两件事：产物落盘、再核一次引擎的门禁结论。
 * 引擎说不过就不登记——绝不把一份画着假数字的页面发到孩子面前。
 */
async function runWebJob(
  state: AppState,
  jobId: string,
  body: WebJobBody,
  payload: { problem: string; grade: string; learner_id?: string; extra_directives?: string },
  mode: WebJobMode,
): Promise<void> {
  const repo = state.repo;
  const fetchImpl = state.engineFetch ?? fetch;
  const engineRoute = mode === "web" ? "plan" : mode === "web_html" ? "html" : "both";
  const focusNodeIds = body.focusNodeId
    ? [body.focusNodeId]
    : ((body.questionId ? state.questions.byId.get(body.questionId)?.nodeIds : undefined) ?? []);

  try {
    const resp = await fetchImpl(`${state.config.engineUrl}/api/v1/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, route: engineRoute }),
      // 模型写码比出 SceneSpec 慢得多（还可能重写两轮），给足时间
      signal: AbortSignal.timeout(engineRoute === "plan" ? 300_000 : 600_000),
    });
    if (!resp.ok) throw new Error(`引擎 plan 响应 ${resp.status}`);
    const result = (await resp.json()) as {
      status: string;
      plan_id: string;
      scene_spec?: unknown;
      html?: string;
      html_gate?: { ok?: boolean; errors?: string[]; warnings?: string[] };
      error?: string;
    };

    const problems: string[] = [];
    if (result.error) problems.push(result.error);

    /** 模型直写的页面：门禁没过一律不登记 */
    let htmlExplanationId: string | undefined;
    if (mode !== "web") {
      const gate = result.html_gate;
      if (!result.html) {
        problems.push(gate?.errors?.[0] ?? "模型未产出讲解页面");
      } else if (gate && gate.ok === false) {
        problems.push(`未通过契约门禁：${(gate.errors ?? []).slice(0, 2).join("；")}`);
      } else {
        const htmlId = randomUUID();
        const htmlDir = path.join(state.config.dataDir, "explanations");
        mkdirSync(htmlDir, { recursive: true });
        writeFileSync(path.join(htmlDir, `${htmlId}.html`), result.html, "utf8");
        htmlExplanationId = randomUUID();
        repo.insertExplanation({
          id: htmlExplanationId,
          questionId: body.questionId,
          focusNodeIds,
          engineSessionId: result.plan_id,
          mode: "web_html",
          htmlUrl: `/api/v1/explain/html/${htmlId}`,
          // 门禁全清才算 good；有建议未处理算 acceptable
          quality: (gate?.warnings?.length ?? 0) > 0 ? "acceptable" : "good",
          contractVersion: state.contract?.contract_version ?? "unknown",
          groundingSource: "llm_html",
        });
      }
    }

    /** SceneSpec：结构检查后落盘 */
    let specExplanationId: string | undefined;
    if (mode !== "web_html") {
      const parsed = SceneSpecSchema.safeParse(result.scene_spec);
      if (!result.scene_spec) {
        problems.push("plan-only 未产出 SceneSpec");
      } else if (!parsed.success) {
        problems.push(`SceneSpec 校验失败: ${parsed.error.issues[0]?.message}`);
      } else {
        // 确定性 spec 结构检查（宪法第 5 条 web 侧门槛）：有对象、有拍子才算合格讲解
        const spec = parsed.data;
        const structuralWarnings: string[] = [];
        if (spec.visual_objects.length === 0) structuralWarnings.push("无可视对象");
        if (spec.scenes.length === 0) structuralWarnings.push("无讲解拍子");
        if (structuralWarnings.length === 2) {
          problems.push("SceneSpec 为空（无对象且无拍子）");
        } else {
          const specId = randomUUID();
          const specsDir = path.join(state.config.dataDir, "specs");
          mkdirSync(specsDir, { recursive: true });
          writeFileSync(path.join(specsDir, `${specId}.json`), JSON.stringify(spec, null, 2), "utf8");
          specExplanationId = randomUUID();
          repo.insertExplanation({
            id: specExplanationId,
            questionId: body.questionId,
            focusNodeIds,
            engineSessionId: result.plan_id,
            mode: "web",
            specUrl: `/api/v1/explain/specs/${specId}`,
            quality: structuralWarnings.length ? "acceptable" : "good",
            contractVersion: state.contract?.contract_version ?? "unknown",
            // 确定性构造器会在计划上盖章；LLM 导演写的计划没有这个字段，留空即代表走了模型路径
            groundingSource: groundingSourceOf(spec),
          });
        }
      }
    }

    // 交付优先级：模型那份 > SceneSpec 那份。both 模式下前者没过门禁就自动退回后者，
    // 于是「试新路」不会让孩子这次没讲解看。
    const delivered = htmlExplanationId ?? specExplanationId;
    if (!delivered) {
      repo.failExplainJob(jobId, problems[0] ?? "引擎未产出讲解");
      return;
    }
    if (body.mistakeId) repo.linkMistakeExplanation(body.mistakeId, delivered);
    repo.finishExplainJob(jobId, delivered);
  } catch (err) {
    repo.failExplainJob(jobId, String(err));
  }
}

const FeedbackSchema = z.object({
  /** clear=讲得清楚 / confusing=没看懂；只有这两个值，多了没人认真填 */
  label: z.enum(["clear", "confusing"]),
  learnerId: z.string().optional(),
  /** both 模式下对比的是哪一份（另一种形态的讲解 id） */
  comparedWith: z.string().optional(),
});

export function explainRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = ExplainSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    // 自由文本按内容哈希生成伪题目 id：缓存/去重/登记与题库题走同一套机制
    const raw = parsed.data;
    const body = {
      ...raw,
      // 不传 mode 时用整机默认（EXPLAIN_WEB_MODE），前端不必知道当前跑哪条路
      mode: raw.mode ?? state.config.defaultWebExplainMode,
      learnerId: effectiveLearnerId(c, state, raw.learnerId) ?? raw.learnerId,
      questionId: raw.questionId ?? (raw.problem ? `free-${contentHashOf(raw.problem, "")}` : undefined),
    };
    const fallback = buildFallback(state, body);

    // 1) 缓存命中（同题优先，其次同根因节点；按模式命中）
    // both 是生成策略而不是产物形态：查缓存时按交付优先级找——先模型那份，再 SceneSpec
    const cached =
      body.mode === "both"
        ? (state.repo.findExplanation(body.questionId, body.focusNodeId, "web_html") ??
          state.repo.findExplanation(body.questionId, body.focusNodeId, "web"))
        : state.repo.findExplanation(body.questionId, body.focusNodeId, body.mode);
    if (cached && (cached.videoUrl || cached.specUrl || cached.htmlUrl)) {
      if (body.mistakeId) state.repo.linkMistakeExplanation(body.mistakeId, cached.id);
      return c.json({
        status: "ready",
        explanation: explanationView(cached),
        alternatives: alternativesOf(state, cached),
        fallback,
      });
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
    if (!question && !focusNode && !body.problem) return c.json({ error: "题目/节点不存在" }, 404);

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
        : (body.problem ??
          `请讲解知识点：${focusNode!.name}——${focusNode!.whatIsIt ?? focusNode!.summary}`),
      grade: body.grade ?? learner?.level ?? question?.level ?? "elementary_upper",
      learner_id: body.learnerId,
      extra_directives: composeDirectives({
        knowledge: state.knowledge,
        question,
        focusNodeId: body.focusNodeId,
        misconceptionId: body.misconceptionId,
      }),
    };
    // 模式 A（web 默认）：plan-only 出 SceneSpec，秒级~分钟级、无渲染
    if (body.mode === "web_html" || body.mode === "both" || body.mode === "web") {
      void runWebJob(state, jobId, body, payload, body.mode);
      return c.json({ status: "generating", jobId, mode: body.mode, fallback }, 202);
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

  /**
   * 模型直写的讲解页面。以 text/html 返回，但**前端必须放进 sandbox iframe**——
   * 这是模型生成的代码，不能与主站同源执行。响应头再上一道 CSP：
   * 只允许内联样式与脚本，禁止任何网络请求，即使门禁漏了也拉不到外面去。
   */
  app.get("/html/:id", (c) => {
    const id = c.req.param("id").replace(/[^\w-]/g, "");
    const file = path.join(state.config.dataDir, "explanations", `${id}.html`);
    if (!existsSync(file)) return c.json({ error: "讲解不存在" }, 404);
    return c.body(readFileSync(file, "utf8"), 200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
        "img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
    });
  });

  /**
   * 人工偏好：哪一份讲得更清楚。门禁只能判「有没有画错」，判不了「讲没讲明白」——
   * 这条标签是后者唯一的来源，也是日后训练最值钱的那部分。
   */
  app.post("/:id/feedback", async (c) => {
    const parsed = FeedbackSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    const id = c.req.param("id");
    const explanation = state.repo.getExplanation(id);
    if (!explanation) return c.json({ error: "讲解不存在" }, 404);
    state.repo.setExplanationFeedback(id, parsed.data.label);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (learnerId && state.repo.getLearner(learnerId)) {
      state.repo.appendEvent(learnerId, "feedback", {
        kind: "explanation",
        explanationId: id,
        label: parsed.data.label,
        mode: explanation.mode,
        // 对比来源：模型直写 vs 哪一个确定性构造器，日后按路线聚合就靠它
        groundingSource: explanation.groundingSource,
        comparedWith: parsed.data.comparedWith,
      });
    }
    return c.json({ ok: true });
  });

  app.get("/jobs/:id", (c) => {
    const job = state.repo.getExplainJob(c.req.param("id"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    const explanation = job.explanationId ? state.repo.getExplanation(job.explanationId) : undefined;
    return c.json({
      status: job.status,
      explanation: explanation ? explanationView(explanation) : undefined,
      alternatives: explanation ? alternativesOf(state, explanation) : undefined,
      error: job.error,
    });
  });

  return app;
}
