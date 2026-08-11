import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { EngineContract } from "@mathtutor/schema";
import { SESSION_COOKIE, type AuthStore, type AuthUser } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import type { Knowledge } from "@mathtutor/knowledge";
import type { ServerConfig } from "./config.js";
import type { Repo } from "./repo.js";
import type { QuestionStore } from "./questions.js";
import type { HintProvider } from "./hint.js";
import type { ExtractionProvider } from "./ingest/extraction.js";
import { proxyToEngine } from "./proxy.js";
import { effectiveP, masteryBand } from "./mastery.js";
import type { JobStore } from "./ingest/jobs.js";
import { learnerRoutes } from "./routes/learners.js";
import { practiceRoutes } from "./routes/practice.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { diagnosisRoutes } from "./routes/diagnosis.js";
import { explainRoutes } from "./explain/routes.js";
import { parentRoutes } from "./routes/parent.js";
import type { PhotoGrader } from "./photoGrader.js";
import { ingestRoutes } from "./ingest/routes.js";
import { exploreRoutes } from "./explore.js";
import { askRoutes } from "./ask.js";
import { bankRoutes } from "./bank.js";
import { loadFigure } from "./figures.js";
import { notesRoutes } from "./notes.js";

export interface AppState {
  config: ServerConfig;
  contract: EngineContract | null;
  knowledge: Knowledge;
  questions: QuestionStore;
  repo: Repo;
  hintProvider: HintProvider | null;
  /** 上传抽取 LLM Provider；null/缺省时 text 走离线兜底、image/pdf 返回 501 */
  extraction?: ExtractionProvider | null;
  /** P1b 批量抽取任务存储；未提供时批量端点返回 503 */
  jobs?: JobStore;
  /** 可注入的引擎 fetch（测试 mock 引擎 SSE 用）；缺省 globalThis.fetch */
  engineFetch?: typeof fetch;
  /** 拍照作答判卷（vision）；未配置时 submit-photo 返回 501 */
  photoGrader?: PhotoGrader | null;
  /** 账户体系；authDisabled=true 时全开放（单测用） */
  auth?: AuthStore | null;
  authDisabled?: boolean;
}

/** 引擎既有 API 中经 server 透传的路径前缀（学生设备永不直连引擎）。 */
const ENGINE_PREFIXES = [
  "/api/v1/chat",
  "/api/v1/problems",
  "/api/v1/sessions",
  "/api/v1/grades",
  "/api/v1/skills",
  "/api/v1/media",
  "/api/health",
];

/**
 * 数据隔离核心：孩子会话强制绑定自己的 learnerId（请求里传什么都会被覆盖）；
 * 家长与关闭认证（单测）时按请求值放行。
 */
export function effectiveLearnerId(
  c: Context,
  state: AppState,
  requested: string | undefined,
): string | undefined {
  if (state.authDisabled || !state.auth) return requested;
  const user = c.get("user") as AuthUser | undefined;
  if (user?.role === "child") return user.learnerId;
  return requested;
}

export function requireParentRole(c: Context, state: AppState): boolean {
  if (state.authDisabled || !state.auth) return true;
  return (c.get("user") as AuthUser | undefined)?.role === "parent";
}

export function createApp(state: AppState): Hono {
  const app = new Hono();

  // ---- 认证中间件：/api 全域必须登录，/api/v1/auth/* 免（登录/注册本身）----
  app.use("/api/*", async (c, next) => {
    if (state.authDisabled || !state.auth) return next();
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? state.auth.userForSession(token) : null;
    if (user) c.set("user", user);
    if (c.req.path.startsWith("/api/v1/auth")) return next(); // 免认证面，但已带上 user
    if (!user) return c.json({ error: "未登录" }, 401);
    return next();
  });

  // ---- 家长专属面（管理员）：家长页 / 录题管线 / 节点核验 / 引擎原始入口 ----
  const parentOnly = async (c: Context, next: () => Promise<void>) => {
    if (!requireParentRole(c, state)) return c.json({ error: "仅家长可用" }, 403);
    return next();
  };
  app.use("/api/v1/parent/*", parentOnly);
  app.use("/api/v1/ingest/*", parentOnly);
  app.use("/api/v1/knowledge/verify-node", parentOnly);
  app.use("/api/v1/chat", parentOnly);
  app.use("/api/v1/chat/*", parentOnly);
  app.use("/api/v1/problems/*", parentOnly);
  app.use("/api/v1/sessions", parentOnly);
  app.use("/api/v1/sessions/*", parentOnly);
  app.use("/api/v1/learners", async (c, next) => {
    // 孩子经 /auth/register-child 建档；直接建 learner 是家长动作
    if (c.req.method === "POST" && !requireParentRole(c, state))
      return c.json({ error: "仅家长可用" }, 403);
    return next();
  });

  app.route("/api/v1/auth", authRoutes(state));

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      engine: state.contract ? "connected" : "offline",
      contract_version: state.contract?.contract_version ?? null,
      questions: state.questions.all.length,
      learners: state.repo.listLearners().length,
      // 当前 Web 讲解走哪条路（EXPLAIN_WEB_MODE）。暴露出来是因为踩过一次：
      // 改了 .env 却忘了重新编译 dist，行为还是旧的，从外面完全看不出来。
      explain_web_mode: state.config.defaultWebExplainMode,
    }),
  );

  // 契约注册表下发：前端工具标签/配色从这里取，禁止硬编码（设计 §05）
  app.get("/api/v1/registry", (c) => {
    if (!state.contract) return c.json({ error: "engine offline" }, 503);
    return c.json(state.contract);
  });

  // 星图数据：图谱 + 题型 + 掌握度着色（?learnerId= 提供时返回该生投影；孩子强制本人）
  app.get("/api/v1/atlas", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    const mastery: Record<string, { p: number; evidenceN: number; band: string }> = {};
    if (learnerId) {
      for (const row of state.repo.allMastery(learnerId)) {
        const p = effectiveP(row);
        mastery[row.nodeId] = { p, evidenceN: row.evidenceN, band: masteryBand(p, row.evidenceN) };
      }
    }
    return c.json({
      graph: state.knowledge.graph,
      problemTypes: state.knowledge.problemTypes,
      mastery,
    });
  });

  app.route("/api/v1/learners", learnerRoutes(state));
  app.route("/api/v1/practice", practiceRoutes(state));
  app.route("/api/v1/knowledge", knowledgeRoutes(state));
  app.route("/api/v1/diagnosis", diagnosisRoutes(state));
  app.route("/api/v1/explain", explainRoutes(state));
  app.route("/api/v1/parent", parentRoutes(state));
  app.route("/api/v1/ingest", ingestRoutes(state));
  app.route("/api/v1/explore", exploreRoutes(state));
  // 自由提问（题库外的题）：转成临时题目，走和练习页一样的纪律（不喂答案）
  app.route("/api/v1/ask", askRoutes(state));
  // 题库管理（家长专属）：列出全部题、就地修改、删除、整批撤回
  app.route("/api/v1/bank", bankRoutes(state));

  /**
   * 题目原图。**不设家长门**——孩子做题时看的就是这张图，
   * 图里只有题干与配图，没有答案（答案在【答案】框里，裁图时不在范围内）。
   */
  app.get("/api/v1/figures/:name", (c) => {
    const found = loadFigure(state.config.figuresDir, c.req.param("name"));
    if (!found) return c.json({ error: "配图不存在" }, 404);
    // Buffer 要转成 Uint8Array：Hono 的 body 只认 string/ArrayBuffer/流
    return new Response(new Uint8Array(found.body), {
      headers: {
        "Content-Type": found.contentType,
        // 名字是内容哈希，同名必然同图，可以放心长缓存
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });
  app.route("/api/v1/notes", notesRoutes(state));

  // 引擎透传（SSE 流式）
  for (const prefix of ENGINE_PREFIXES) {
    app.all(`${prefix}/*`, (c) => proxyToEngine(c, state.config.engineUrl));
    app.all(prefix, (c) => proxyToEngine(c, state.config.engineUrl));
  }

  return app;
}
