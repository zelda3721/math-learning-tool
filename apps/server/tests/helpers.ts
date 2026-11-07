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
  linksPath: fileURLToPath(new URL("../../../data/knowledge/links.json", import.meta.url)),
  // 英语图一起加载：跨学科连接要按 id 找得到对面，测试也得在同样的形态下跑
  subjectGraphPaths: [fileURLToPath(new URL("../../../subjects/english/graph.json", import.meta.url))],
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
    // figuresDir 必须跟着进临时目录：默认值指向仓库 media/figures，
    // 题库删题会顺手 prune "没被引用"的原图——在测试里等于清空真实的图库
    // （实机事故：跑一遍单测，讲义原图全没了）
    config: { ...loadConfig({}), dataDir, figuresDir: path.join(dataDir, "figures") },
    contract: null,
    knowledge,
    questions: store,
    repo,
    hintProvider: null,
    jobs: new JobStore(db),
    authDisabled: true, // 既有测试聚焦业务逻辑；认证路径由 auth.test.ts 专测
  };
  return { dataDir, store, repo, state };
}

export function makeApp(questions: Question[], overrides: Partial<AppState> = {}) {
  const env = tempFixtureEnv(questions);
  // overrides 用来注入需要外部依赖的部件（如语义判卷的 judge），
  // 让"AI 确认"这类路径也可测，而不必真连模型
  const state: AppState = { ...env.state, ...overrides };
  return { app: createApp(state), ...env, state };
}
