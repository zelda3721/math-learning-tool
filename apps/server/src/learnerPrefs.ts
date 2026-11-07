import type { DatabaseSync } from "node:sqlite";

/**
 * 学习者偏好读写（`learners.prefs_json`）。
 *
 * 这张字段一直存在但没人用：家长调不了任何东西，孩子也没有"被记住的偏好"。
 * 用它而不是新开一张表，是因为偏好本来就是**属于这个孩子的一小块配置**，
 * 单开表只会多一次 join，还得处理"learner 删了偏好还在"的孤儿数据。
 *
 * 写得谨慎一点：坏 JSON 一律当空对象——配置读坏不该让孩子打不开页面。
 */
export interface LearnerPrefs {
  /** 每天可用于开放对话的分钟数；未设置时按学段默认值 */
  dailyChatMinutes?: number;
  /** 家长显式关掉的模块 */
  disabledModules?: string[];
  /** 学习者画像：兴趣（出题素材）、目标、更吃图形还是式子 */
  interests?: string[];
  goals?: string[];
  prefersVisual?: boolean | null;
}

export function readLearnerPrefs(db: DatabaseSync, learnerId: string): LearnerPrefs {
  const row = db.prepare("SELECT prefs_json FROM learners WHERE id = ?").get(learnerId);
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(String(row.prefs_json ?? "{}"));
    return parsed && typeof parsed === "object" ? (parsed as LearnerPrefs) : {};
  } catch {
    return {};
  }
}

/** 局部更新：只写传进来的字段，其余保持原样（家长改时长不该顺手清掉别的设置） */
export function writeLearnerPrefs(db: DatabaseSync, learnerId: string, patch: LearnerPrefs): void {
  const current = readLearnerPrefs(db, learnerId);
  db.prepare("UPDATE learners SET prefs_json = ? WHERE id = ?").run(JSON.stringify({ ...current, ...patch }), learnerId);
}
