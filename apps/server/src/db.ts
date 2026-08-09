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

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dataDir, "app.sqlite"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  return db;
}

export function openMemoryDb(): DatabaseSync {
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}
