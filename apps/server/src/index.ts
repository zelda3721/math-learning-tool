import { serve } from "@hono/node-server";
import path from "node:path";
import { type Knowledge, loadKnowledge } from "@mathtutor/knowledge";
import { loadLlmConfig } from "@mathtutor/llm-client";
import { applyDotEnv, loadConfig } from "./config.js";
import { fetchEngineContract, ContractError } from "./contract.js";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { Repo } from "./repo.js";
import { createQuestionStore } from "./questions.js";
import type { HintProvider } from "./hint.js";
import { createLlmExtractionProvider, type ExtractionProvider } from "./ingest/extraction.js";
import { auditDataDir, createServerLlmClient } from "./llm.js";
import { SUBJECT_GRAPH_PATHS } from "./subjectGraphs.js";
import { JobStore } from "./ingest/jobs.js";
import { createPhotoGrader } from "./photoGrader.js";
import { createTextbookCompiler } from "./textbookCompiler.js";
import { buildAnswerJudge } from "./semanticJudge.js";
import { AuthStore } from "./auth.js";
import { createSubjectRegistry } from "./subjects.js";
import { withModuleGate } from "./modules.js";
import type { AppState } from "./app.js";

function buildHintProvider(): HintProvider | null {
  try {
    const config = loadLlmConfig(process.env);
    const client = createServerLlmClient(config, "fast", { dataDir: auditDataDir(process.env) });
    return {
      async generate(prompt: string): Promise<string> {
        let text = "";
        for await (const ev of client.chat([{ role: "user", content: prompt }], {
          maxTokens: 600,
          temperature: 0.4,
        })) {
          if (ev.type === "text") text += ev.text;
        }
        return text;
      },
    };
  } catch (err) {
    console.warn(`[hint] LLM 提示不可用，使用静态兜底: ${String(err)}`);
    return null;
  }
}

function buildExtractionProvider(knowledge: Knowledge): ExtractionProvider | null {
  try {
    // 把知识层交给抽取器：候选清单进系统提示词，模型才能点名而不是自由发挥
    return createLlmExtractionProvider(process.env, { knowledge });
  } catch (err) {
    console.warn(`[ingest] LLM 抽取不可用，文本上传走离线兜底: ${String(err)}`);
    return null;
  }
}

async function main(): Promise<void> {
  applyDotEnv(); // 与引擎共享仓库根 .env（真实环境变量优先）
  const config = loadConfig();

  let contract;
  try {
    contract = await fetchEngineContract(config.engineUrl, config.allowEngineOffline);
  } catch (err) {
    if (err instanceof ContractError) {
      console.error(`[fatal] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const knowledge = loadKnowledge({
    graphPath: path.join(config.dataDir, "knowledge", "graph.json"),
    problemsPath: path.join(config.dataDir, "knowledge", "problems.json"),
    linksPath: path.join(config.dataDir, "knowledge", "links.json"),
    // 其他学科的图谱并进同一张图：星图、掌握度、跨学科连接都按 id 互相找得到
    subjectGraphPaths: SUBJECT_GRAPH_PATHS,
  });
  const db = openDb(config.dataDir);
  const repo = new Repo(db);
  const questions = createQuestionStore(config.dataDir, knowledge.index);

  const state: AppState = {
    config,
    contract,
    knowledge,
    // 学科装配只有一处（subjects.ts）：加学科改那一行，这里不用动
    subjects: createSubjectRegistry(),
    questions,
    repo,
    hintProvider: buildHintProvider(),
    judge: buildAnswerJudge(),
    extraction: buildExtractionProvider(knowledge),
    // 知识编译走 main 端点（本地 oMLX 常驻模型）；这里只建客户端，不预热、不拉模型
    textbookProvider: createTextbookCompiler(process.env, { dataDir: auditDataDir(process.env) }),
    jobs: new JobStore(db),
    auth: new AuthStore(db),
    photoGrader: (() => {
      try {
        return createPhotoGrader(process.env);
      } catch (err) {
        console.warn(`[photo] vision 判卷不可用: ${String(err)}`);
        return null;
      }
    })(),
  };
  /*
   * 组合根统一套一层模块闸：家长关掉某个模块后，那一段前缀在进路由之前就 403。
   * 为什么放在这里而不是 createApp 里：路由装配那一侧不在本次改动范围；
   * 这一层与 app 的行为完全等价（中间件先跑，再进原 app）。
   */
  const app = withModuleGate(createApp(state), state);
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`MathTutor server listening on http://${info.address}:${info.port}`);
    console.log(`  engine:    ${config.engineUrl} (${contract ? contract.contract_version : "OFFLINE"})`);
    console.log(`  data:      ${config.dataDir}`);
    console.log(`  questions: ${questions.all.length}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
