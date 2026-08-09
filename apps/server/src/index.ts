import { serve } from "@hono/node-server";
import path from "node:path";
import { loadKnowledge } from "@mathtutor/knowledge";
import { LlmClient, loadLlmConfig } from "@mathtutor/llm-client";
import { loadConfig } from "./config.js";
import { fetchEngineContract, ContractError } from "./contract.js";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { Repo } from "./repo.js";
import { createQuestionStore } from "./questions.js";
import type { HintProvider } from "./hint.js";
import { createLlmExtractionProvider, type ExtractionProvider } from "./ingest/extraction.js";
import { JobStore } from "./ingest/jobs.js";

function buildHintProvider(): HintProvider | null {
  try {
    const config = loadLlmConfig(process.env);
    const endpoint = config.fast;
    const client = new LlmClient({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
    });
    return {
      async generate(prompt: string): Promise<string> {
        let text = "";
        for await (const ev of client.chat([{ role: "user", content: prompt }], {
          maxTokens: 200,
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

function buildExtractionProvider(): ExtractionProvider | null {
  try {
    return createLlmExtractionProvider(process.env);
  } catch (err) {
    console.warn(`[ingest] LLM 抽取不可用，文本上传走离线兜底: ${String(err)}`);
    return null;
  }
}

async function main(): Promise<void> {
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
  });
  const db = openDb(config.dataDir);
  const repo = new Repo(db);
  const questions = createQuestionStore(config.dataDir, knowledge.index);

  const app = createApp({
    config,
    contract,
    knowledge,
    questions,
    repo,
    hintProvider: buildHintProvider(),
    extraction: buildExtractionProvider(),
    jobs: new JobStore(db),
  });
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
