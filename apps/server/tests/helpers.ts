import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadKnowledge, type Knowledge } from "@mathtutor/knowledge";
import type { Question } from "@mathtutor/schema";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { JobStore } from "../src/ingest/jobs.js";
import { createQuestionStore, contentHashOf, type QuestionStore } from "../src/questions.js";
import { createApp, type AppState } from "../src/app.js";
import { loadConfig } from "../src/config.js";

export const knowledge: Knowledge = loadKnowledge({
  graphPath: fileURLToPath(new URL("../../../data/knowledge/graph.json", import.meta.url)),
  problemsPath: fileURLToPath(new URL("../../../data/knowledge/problems.json", import.meta.url)),
});

/** 取真实图谱里的节点 id，保证 fixture 题目通过悬挂检查 */
const nodeIds = knowledge.graph.nodes.map((n) => n.id);
export const NODE_A = nodeIds[0]!;
export const NODE_B = nodeIds[1]!;

export function makeQuestion(partial: Partial<Question> & { id: string }): Question {
  const stem = partial.stem ?? `题目 ${partial.id}`;
  const answer = partial.answer ?? "26";
  return {
    nodeIds: [NODE_A],
    level: "elementary_upper",
    options: undefined,
    answerType: "numeric",
    analysis: undefined,
    difficulty: 2,
    source: { role: "manual" },
    variantOf: undefined,
    problemTypeId: undefined,
    contentHash: contentHashOf(stem, answer),
    status: "verified",
    ...partial,
    stem,
    answer,
  };
}

export function tempFixtureEnv(questions: Question[]): {
  dataDir: string;
  store: QuestionStore;
  repo: Repo;
  state: AppState;
} {
  const dataDir = mkdtempSync(path.join(tmpdir(), "mathtutor-test-"));
  const qdir = path.join(dataDir, "knowledge", "questions");
  mkdirSync(qdir, { recursive: true });
  writeFileSync(path.join(qdir, "fixture.json"), JSON.stringify(questions), "utf8");
  const store = createQuestionStore(dataDir, knowledge.index);
  const db = openMemoryDb();
  const repo = new Repo(db);
  const state: AppState = {
    config: { ...loadConfig({}), dataDir },
    contract: null,
    knowledge,
    questions: store,
    repo,
    hintProvider: null,
    jobs: new JobStore(db),
  };
  return { dataDir, store, repo, state };
}

export function makeApp(questions: Question[]) {
  const env = tempFixtureEnv(questions);
  return { app: createApp(env.state), ...env };
}
