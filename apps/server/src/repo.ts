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
