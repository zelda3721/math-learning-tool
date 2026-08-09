import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Attempt, EducationLevel, Learner } from "@mathtutor/schema";

export interface MasteryRow {
  learnerId: string;
  nodeId: string;
  p: number;
  evidenceN: number;
  lastEvidenceAt: string | null;
}

export class Repo {
  constructor(private readonly db: DatabaseSync) {}

  // ---- learners ----
  createLearner(name: string, level: EducationLevel): Learner {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO learners (id, name, level, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, level, new Date().toISOString());
    return { id, name, level };
  }

  listLearners(): Learner[] {
    const rows = this.db.prepare("SELECT id, name, level FROM learners ORDER BY created_at").all();
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), level: r.level as EducationLevel }));
  }

  getLearner(id: string): Learner | undefined {
    const r = this.db.prepare("SELECT id, name, level FROM learners WHERE id = ?").get(id);
    return r ? { id: String(r.id), name: String(r.name), level: r.level as EducationLevel } : undefined;
  }

  // ---- attempts ----
  insertAttempt(a: Omit<Attempt, "id" | "at"> & { at?: string }): Attempt {
    const id = randomUUID();
    const at = a.at ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO attempts (id, learner_id, question_id, answer, correct, hint_level_used,
          source, duration_s, needs_review, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        a.learnerId,
        a.questionId,
        a.answer,
        a.correct ? 1 : 0,
        a.hintLevelUsed,
        a.source,
        a.durationS ?? null,
        a.needsReview ? 1 : 0,
        at,
      );
    return { ...a, id, at, needsReview: a.needsReview };
  }

  getAttempt(id: string): (Attempt & { at: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(id);
    if (!r) return undefined;
    return {
      id: String(r.id),
      learnerId: String(r.learner_id),
      questionId: String(r.question_id),
      answer: String(r.answer),
      correct: Boolean(r.correct),
      hintLevelUsed: Number(r.hint_level_used) as 0 | 1 | 2 | 3,
      source: r.source as Attempt["source"],
      durationS: r.duration_s === null ? undefined : Number(r.duration_s),
      needsReview: Boolean(r.needs_review),
      parentVerdict: (r.parent_verdict ?? undefined) as Attempt["parentVerdict"],
      parentNote: (r.parent_note ?? undefined) as string | undefined,
      at: String(r.at),
    };
  }

  /** 近 N 天内做对过的题（组卷排除，避免重复刷同题） */
  recentlyCorrectQuestionIds(learnerId: string, days: number): Set<string> {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = this.db
      .prepare(
        "SELECT DISTINCT question_id FROM attempts WHERE learner_id = ? AND correct = 1 AND at >= ?",
      )
      .all(learnerId, since);
    return new Set(rows.map((r) => String(r.question_id)));
  }

  attemptedQuestionIds(learnerId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT question_id FROM attempts WHERE learner_id = ?")
      .all(learnerId);
    return new Set(rows.map((r) => String(r.question_id)));
  }

  // ---- mastery ----
  getMastery(learnerId: string, nodeId: string): MasteryRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM mastery WHERE learner_id = ? AND node_id = ?")
      .get(learnerId, nodeId);
    if (!r) return undefined;
    return {
      learnerId,
      nodeId,
      p: Number(r.p),
      evidenceN: Number(r.evidence_n),
      lastEvidenceAt: r.last_evidence_at === null ? null : String(r.last_evidence_at),
    };
  }

  allMastery(learnerId: string): MasteryRow[] {
    const rows = this.db.prepare("SELECT * FROM mastery WHERE learner_id = ?").all(learnerId);
    return rows.map((r) => ({
      learnerId,
      nodeId: String(r.node_id),
      p: Number(r.p),
      evidenceN: Number(r.evidence_n),
      lastEvidenceAt: r.last_evidence_at === null ? null : String(r.last_evidence_at),
    }));
  }

  upsertMastery(row: MasteryRow): void {
    this.db
      .prepare(
        `INSERT INTO mastery (learner_id, node_id, p, evidence_n, last_evidence_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(learner_id, node_id) DO UPDATE SET
           p = excluded.p, evidence_n = excluded.evidence_n,
           last_evidence_at = excluded.last_evidence_at`,
      )
      .run(row.learnerId, row.nodeId, row.p, row.evidenceN, row.lastEvidenceAt);
  }

  // ---- events（append-only；mastery 是它的可重放投影） ----
  appendEvent(learnerId: string, type: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO learner_events (id, learner_id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), learnerId, new Date().toISOString(), type, JSON.stringify(payload));
  }

  // ---- mistakes（P2 错因坐标） ----
  insertMistake(m: {
    id: string;
    attemptId: string;
    learnerId: string;
    questionId: string;
    surface: string;
    rootNodeId: string;
    misconceptionId?: string;
    chain: string[];
    confidence: number;
    eligible: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO mistakes (id, attempt_id, learner_id, question_id, surface, root_node_id,
          misconception_id, chain_json, confidence, eligible, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.attemptId,
        m.learnerId,
        m.questionId,
        m.surface,
        m.rootNodeId,
        m.misconceptionId ?? null,
        JSON.stringify(m.chain),
        m.confidence,
        m.eligible ? 1 : 0,
        new Date().toISOString(),
      );
  }

  private rowToMistake(r: Record<string, unknown>) {
    return {
      id: String(r.id),
      attemptId: String(r.attempt_id),
      learnerId: String(r.learner_id),
      questionId: String(r.question_id),
      surface: String(r.surface),
      rootNodeId: String(r.root_node_id),
      misconceptionId: r.misconception_id === null ? undefined : String(r.misconception_id),
      chain: JSON.parse(String(r.chain_json)) as string[],
      confidence: Number(r.confidence),
      eligible: Boolean(r.eligible),
      explanationArtifactId: r.explanation_artifact_id === null ? undefined : String(r.explanation_artifact_id),
      createdAt: String(r.created_at),
    };
  }

  getMistake(id: string) {
    const r = this.db.prepare("SELECT * FROM mistakes WHERE id = ?").get(id);
    return r ? this.rowToMistake(r as Record<string, unknown>) : undefined;
  }

  listMistakes(learnerId: string, limit = 50) {
    return this.db
      .prepare("SELECT * FROM mistakes WHERE learner_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(learnerId, limit)
      .map((r) => this.rowToMistake(r as Record<string, unknown>));
  }

  /** 未被家长纠正的、以该节点为根因的错因（探针回填的目标） */
  openMistakesByRoot(learnerId: string, rootNodeId: string) {
    return this.db
      .prepare("SELECT * FROM mistakes WHERE learner_id = ? AND root_node_id = ? AND corrected_by_parent = 0")
      .all(learnerId, rootNodeId)
      .map((r) => this.rowToMistake(r as Record<string, unknown>));
  }

  updateMistakeConfidence(id: string, confidence: number, probeEvidenced: boolean): void {
    // 探针作答即实证：未核验节点经探针后 eligible 翻正（替代证据通道，宪法第 6 条）
    this.db
      .prepare(`UPDATE mistakes SET confidence = ?${probeEvidenced ? ", eligible = 1" : ""} WHERE id = ?`)
      .run(confidence, id);
  }

  linkMistakeExplanation(mistakeId: string, explanationId: string): void {
    this.db
      .prepare("UPDATE mistakes SET explanation_artifact_id = ? WHERE id = ?")
      .run(explanationId, mistakeId);
  }

  // ---- explanations（P2 讲解产物登记） ----
  insertExplanation(e: {
    id: string;
    questionId?: string;
    focusNodeIds: string[];
    engineSessionId: string;
    mode: "web" | "video";
    videoUrl?: string;
    subtitleUrl?: string;
    quality: "good" | "acceptable";
    contractVersion: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO explanations (id, question_id, focus_node_ids_json, engine_session_id, mode,
          video_url, subtitle_url, quality, contract_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.questionId ?? null,
        JSON.stringify(e.focusNodeIds),
        e.engineSessionId,
        e.mode,
        e.videoUrl ?? null,
        e.subtitleUrl ?? null,
        e.quality,
        e.contractVersion,
        new Date().toISOString(),
      );
  }

  private rowToExplanation(r: Record<string, unknown>) {
    return {
      id: String(r.id),
      questionId: r.question_id === null ? undefined : String(r.question_id),
      focusNodeIds: JSON.parse(String(r.focus_node_ids_json)) as string[],
      engineSessionId: String(r.engine_session_id),
      mode: String(r.mode) as "web" | "video",
      videoUrl: r.video_url === null ? undefined : String(r.video_url),
      subtitleUrl: r.subtitle_url === null ? undefined : String(r.subtitle_url),
      quality: String(r.quality) as "good" | "acceptable",
      contractVersion: String(r.contract_version),
      createdAt: String(r.created_at),
    };
  }

  getExplanation(id: string) {
    const r = this.db.prepare("SELECT * FROM explanations WHERE id = ?").get(id);
    return r ? this.rowToExplanation(r as Record<string, unknown>) : undefined;
  }

  /** 讲解缓存查找：优先同题，其次同根因节点 */
  findExplanation(questionId: string | undefined, focusNodeId: string | undefined) {
    if (questionId) {
      const r = this.db
        .prepare("SELECT * FROM explanations WHERE question_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(questionId);
      if (r) return this.rowToExplanation(r as Record<string, unknown>);
    }
    if (focusNodeId) {
      const rows = this.db.prepare("SELECT * FROM explanations ORDER BY created_at DESC LIMIT 50").all();
      for (const r of rows) {
        const e = this.rowToExplanation(r as Record<string, unknown>);
        if (e.focusNodeIds.includes(focusNodeId)) return e;
      }
    }
    return undefined;
  }

  // ---- explain jobs（P2 讲解生成队列） ----
  createExplainJob(job: { learnerId?: string; questionId?: string; focusNodeIds: string[] }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO explain_jobs (id, learner_id, question_id, focus_node_ids_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(id, job.learnerId ?? null, job.questionId ?? null, JSON.stringify(job.focusNodeIds), now, now);
    return id;
  }

  finishExplainJob(id: string, explanationId: string): void {
    this.db
      .prepare("UPDATE explain_jobs SET status = 'done', explanation_id = ?, updated_at = ? WHERE id = ?")
      .run(explanationId, new Date().toISOString(), id);
  }

  failExplainJob(id: string, error: string): void {
    this.db
      .prepare("UPDATE explain_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error, new Date().toISOString(), id);
  }

  getExplainJob(id: string) {
    const r = this.db.prepare("SELECT * FROM explain_jobs WHERE id = ?").get(id);
    if (!r) return undefined;
    return {
      id: String(r.id),
      learnerId: r.learner_id === null ? undefined : String(r.learner_id),
      questionId: r.question_id === null ? undefined : String(r.question_id),
      focusNodeIds: JSON.parse(String(r.focus_node_ids_json)) as string[],
      status: String(r.status) as "running" | "done" | "failed",
      explanationId: r.explanation_id === null ? undefined : String(r.explanation_id),
      error: r.error === null ? undefined : String(r.error),
    };
  }

  /** 有 running 讲解任务时避免重复排队（同题去重） */
  runningExplainJobForQuestion(questionId: string): string | undefined {
    const r = this.db
      .prepare("SELECT id FROM explain_jobs WHERE question_id = ? AND status = 'running' LIMIT 1")
      .get(questionId);
    return r ? String(r.id) : undefined;
  }

  // ---- queue（P1a 只消费；P2 探针、P3 复习开始生产） ----
  pushQueueItem(learnerId: string, kind: "probe" | "review", questionId: string, dueAt: string): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO queue_items (id, learner_id, kind, question_id, due_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, learnerId, kind, questionId, dueAt);
    return id;
  }

  dueQueueQuestionIds(learnerId: string, limit: number): { id: string; questionId: string }[] {
    const rows = this.db
      .prepare(
        `SELECT id, question_id FROM queue_items
         WHERE learner_id = ? AND consumed_at IS NULL AND due_at <= ?
         ORDER BY due_at LIMIT ?`,
      )
      .all(learnerId, new Date().toISOString(), limit);
    return rows.map((r) => ({ id: String(r.id), questionId: String(r.question_id) }));
  }

  consumeQueueItem(id: string): void {
    this.db
      .prepare("UPDATE queue_items SET consumed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }
}
