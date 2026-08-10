import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// createRequire 动态加载：vite/vitest（5.4）还不认识 node:sqlite 这个新内建模块，
// 静态 import 会被当成待打包依赖而失败；运行时语义完全等价。
const requireBuiltin = createRequire(import.meta.url);
const sqlite = requireBuiltin("node:sqlite") as typeof import("node:sqlite");

/**
 * 学习者层 DB-first（设计 §06）：app.sqlite 存运行时行为数据。
 * 知识层（graph/problems/questions）是 file-first git JSON，不进这个库。
 * 用 Node 内建 node:sqlite（零原生依赖，家庭单机足够）。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS learners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level TEXT NOT NULL,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  correct INTEGER NOT NULL,
  hint_level_used INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'daily',
  duration_s REAL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  parent_verdict TEXT,
  parent_note TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_learner ON attempts(learner_id, at);
CREATE INDEX IF NOT EXISTS idx_attempts_question ON attempts(learner_id, question_id, at);
CREATE TABLE IF NOT EXISTS mastery (
  learner_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  p REAL NOT NULL,
  evidence_n INTEGER NOT NULL DEFAULT 0,
  last_evidence_at TEXT,
  PRIMARY KEY (learner_id, node_id)
);
CREATE TABLE IF NOT EXISTS learner_events (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_learner ON learner_events(learner_id, ts);
-- P1a 最小队列：P2 起探针入队、P3 起复习入队；组卷器最先消费这里
CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'probe' | 'review'
  question_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  consumed_at TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_queue_due ON queue_items(learner_id, due_at, consumed_at);
-- 账户体系：家长 = 管理员（唯一），孩子自注册（上限 5），孩子账号绑定 learner
CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,              -- 'parent' | 'child'
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  learner_id TEXT,                 -- child 绑定的 learner；parent 为 NULL
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
-- P3 SM-2 复习卡：复习 = 同题型换题再练（宪法第 3 条）；答对进档、答错回退 2 档
CREATE TABLE IF NOT EXISTS review_cards (
  id TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,       -- 'question' | 'node'
  target_id TEXT NOT NULL,
  stage INTEGER NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  next_review_at TEXT NOT NULL,
  lapse_count INTEGER NOT NULL DEFAULT 0,
  mastered_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (learner_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS idx_review_due ON review_cards(learner_id, next_review_at, mastered_at);
-- P2 错因归因：错因 = 图谱坐标 (root_node_id, misconception_id?)，附证据与置信度（宪法第 4 条）
CREATE TABLE IF NOT EXISTS mistakes (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  learner_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  surface TEXT NOT NULL,           -- concept | procedure | calculation | reading
  root_node_id TEXT NOT NULL,
  misconception_id TEXT,
  chain_json TEXT NOT NULL,        -- 归因回溯路径（依据知识链，UI 明示）
  confidence REAL NOT NULL,
  eligible INTEGER NOT NULL,       -- 承重门槛：根因节点 verified 或有实证才为 1（宪法第 6 条）
  explanation_artifact_id TEXT,
  corrected_by_parent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mistakes_learner ON mistakes(learner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mistakes_root ON mistakes(learner_id, root_node_id);
-- P2 讲解产物登记（引用引擎会话，不入 git 知识层）
CREATE TABLE IF NOT EXISTS explanations (
  id TEXT PRIMARY KEY,
  question_id TEXT,
  focus_node_ids_json TEXT NOT NULL,
  engine_session_id TEXT NOT NULL,
  mode TEXT NOT NULL,              -- 'web'(SceneSpec) | 'web_html'(模型直写页面) | 'video'
  spec_url TEXT,
  html_url TEXT,                   -- web_html 模式的自足页面产物
  video_url TEXT,
  subtitle_url TEXT,
  quality TEXT NOT NULL,           -- good | acceptable
  contract_version TEXT NOT NULL,
  -- 这份讲解的画面是谁设计的：确定性构造器盖的章（linear_mix_swap /
  -- quantity_story / derivative…），LLM 导演写的计划则为 NULL。
  -- 不记这一笔，就看不出画质波动来自哪条路径，只能凭感觉调。
  grounding_source TEXT,
  feedback_label TEXT,
  variant_pass_rate REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explanations_question ON explanations(question_id);
-- P2 讲解生成任务（当天错题排队；夜间预生成后续接入同一张表）
CREATE TABLE IF NOT EXISTS explain_jobs (
  id TEXT PRIMARY KEY,
  learner_id TEXT,
  question_id TEXT,
  focus_node_ids_json TEXT NOT NULL,
  status TEXT NOT NULL,            -- running | done | failed
  mode TEXT NOT NULL DEFAULT 'video',  -- 'web'（plan-only spec）| 'video'（Manim）
  explanation_id TEXT,
  error TEXT,
  note TEXT,                       -- 非致命备注：如 both 模式下模型那份为何被弃用
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- P6 提问任务（孩子自由提问 → 引擎 plan → 临时题目入库；产物是「题」不是「讲解」，
-- 所以不复用 explain_jobs：那张表按 question_id 去重 running 讲解任务，
-- 塞进来会让 explain 把提问任务当讲解任务返回给前端）
CREATE TABLE IF NOT EXISTS ask_jobs (
  id TEXT PRIMARY KEY,
  learner_id TEXT,
  question_id TEXT NOT NULL,       -- 目标临时题 id（free-<stem hash>，成功后即入库题 id）
  problem TEXT NOT NULL,
  status TEXT NOT NULL,            -- running | done | failed
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ask_jobs_question ON ask_jobs(question_id, status);
-- P1b 批量抽取任务（运行时状态；抽取结果草稿在 result_json，确认后才进 file-first 题库）
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,            -- 'running' | 'done' | 'failed'
  batch_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT
);
`;

/** 旧库容错迁移（列已存在则跳过；node:sqlite 没有 IF NOT EXISTS 语法） */
const MIGRATIONS = [
  "ALTER TABLE explain_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'video'",
  "ALTER TABLE explanations ADD COLUMN grounding_source TEXT",
  "ALTER TABLE explanations ADD COLUMN html_url TEXT",
  "ALTER TABLE explain_jobs ADD COLUMN note TEXT",
];

function migrate(db: DatabaseSync): void {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      // duplicate column — already migrated
    }
  }
}

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dataDir, "app.sqlite"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function openMemoryDb(): DatabaseSync {
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
