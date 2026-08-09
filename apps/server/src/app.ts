import { Hono } from "hono";
import type { EngineContract } from "@mathtutor/schema";
import type { ServerConfig } from "./config.js";
import { getKnowledge } from "./atlas.js";
import { proxyToEngine } from "./proxy.js";

export interface AppState {
  config: ServerConfig;
  contract: EngineContract | null;
}

/** 引擎既有 API 中经 server 透传的路径前缀（P0：chat/sessions/grades/media/health 原样代理）。 */
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
    }),
  );

  // 契约注册表下发：前端工具标签/配色从这里取，禁止硬编码（设计 §05）
  app.get("/api/v1/registry", (c) => {
    if (!state.contract) return c.json({ error: "engine offline" }, 503);
    return c.json(state.contract);
  });

  // 星图数据：图谱 + 题型 + （P0 全灰的）掌握度占位
  app.get("/api/v1/atlas", (c) => {
    const knowledge = getKnowledge(state.config.dataDir);
    return c.json({
      graph: knowledge.graph,
      problemTypes: knowledge.problemTypes,
      mastery: {}, // P0：掌握度全灰；P1a 起由 learner 层填充
    });
  });

  // 引擎透传（SSE 流式）
  for (const prefix of ENGINE_PREFIXES) {
    app.all(`${prefix}/*`, (c) => proxyToEngine(c, state.config.engineUrl));
    app.all(prefix, (c) => proxyToEngine(c, state.config.engineUrl));
  }

  return app;
}
