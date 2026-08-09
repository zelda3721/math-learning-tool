import { Hono } from "hono";
import type { EngineContract } from "@mathtutor/schema";
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
import { ingestRoutes } from "./ingest/routes.js";

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

export function createApp(state: AppState): Hono {
  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      engine: state.contract ? "connected" : "offline",
      contract_version: state.contract?.contract_version ?? null,
      questions: state.questions.all.length,
      learners: state.repo.listLearners().length,
    }),
  );

  // 契约注册表下发：前端工具标签/配色从这里取，禁止硬编码（设计 §05）
  app.get("/api/v1/registry", (c) => {
    if (!state.contract) return c.json({ error: "engine offline" }, 503);
    return c.json(state.contract);
  });

  // 星图数据：图谱 + 题型 + 掌握度着色（?learnerId= 提供时返回该生投影）
  app.get("/api/v1/atlas", (c) => {
    const learnerId = c.req.query("learnerId");
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
  app.route("/api/v1/ingest", ingestRoutes(state));

  // 引擎透传（SSE 流式）
  for (const prefix of ENGINE_PREFIXES) {
    app.all(`${prefix}/*`, (c) => proxyToEngine(c, state.config.engineUrl));
    app.all(prefix, (c) => proxyToEngine(c, state.config.engineUrl));
  }

  return app;
}
