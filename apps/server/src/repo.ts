import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Attempt, EducationLevel, Learner } from "@mathtutor/schema";

export interface ReviewCardRow {
  id: string;
  learnerId: string;
  targetKind: "question" | "node";
  targetId: string;
  stage: number;
  ease: number;
  nextReviewAt: string;
  lapseCount: number;
  masteredAt?: string;
}

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
  /**
   * 讲解画面的来源分布：确定性构造器各接管了多少、多少掉到了 LLM 导演。
   * 画质波动到底来自哪条路径，只有这张表能回答——不统计就只能凭感觉调。
   * 全库口径（不分 learner）：这是产线质量指标，不是某个孩子的学习数据。
   */
  explanationSources(): {
    mode: string;
    source: string;
    quality: string;
    count: number;
  }[] {
    return this.db
      .prepare(
        `SELECT mode,
                COALESCE(grounding_source, 'llm_director') AS source,
                quality,
                COUNT(*) AS count
           FROM explanations
          GROUP BY mode, source, quality
          ORDER BY count DESC`,
      )
      .all() as { mode: string; source: string; quality: string; count: number }[];
  }

  insertExplanation(e: {
    id: string;
    questionId?: string;
    focusNodeIds: string[];
    engineSessionId: string;
    mode: "web" | "video";
    specUrl?: string;
    videoUrl?: string;
    subtitleUrl?: string;
    quality: "good" | "acceptable";
    contractVersion: string;
    /** 画面由谁设计：确定性构造器的章；LLM 导演写的计划没有，留空 */
    groundingSource?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO explanations (id, question_id, focus_node_ids_json, engine_session_id, mode,
          spec_url, video_url, subtitle_url, quality, contract_version, grounding_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.questionId ?? null,
        JSON.stringify(e.focusNodeIds),
        e.engineSessionId,
        e.mode,
        e.specUrl ?? null,
        e.videoUrl ?? null,
        e.subtitleUrl ?? null,
        e.quality,
        e.contractVersion,
        e.groundingSource ?? null,
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
      specUrl: r.spec_url === null || r.spec_url === undefined ? undefined : String(r.spec_url),
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

  /** 讲解缓存查找：优先同题，其次同根因节点；mode 指定时只命中该模式 */
  findExplanation(questionId: string | undefined, focusNodeId: string | undefined, mode?: "web" | "video") {
    if (questionId) {
      const r = this.db
        .prepare(
          `SELECT * FROM explanations WHERE question_id = ?${mode ? " AND mode = ?" : ""}
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(...(mode ? [questionId, mode] : [questionId]));
      if (r) return this.rowToExplanation(r as Record<string, unknown>);
    }
    if (focusNodeId) {
      const rows = this.db.prepare("SELECT * FROM explanations ORDER BY created_at DESC LIMIT 50").all();
      for (const r of rows) {
        const e = this.rowToExplanation(r as Record<string, unknown>);
        if (e.focusNodeIds.includes(focusNodeId) && (!mode || e.mode === mode)) return e;
      }
    }
    return undefined;
  }

  // ---- explain jobs（P2 讲解生成队列） ----
  createExplainJob(job: {
    learnerId?: string;
    questionId?: string;
    focusNodeIds: string[];
    mode?: "web" | "video";
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO explain_jobs (id, learner_id, question_id, focus_node_ids_json, status, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        id,
        job.learnerId ?? null,
        job.questionId ?? null,
        JSON.stringify(job.focusNodeIds),
        job.mode ?? "video",
        now,
        now,
      );
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

  /** 有 running 讲解任务时避免重复排队（同题同模式去重） */
  runningExplainJobForQuestion(questionId: string, mode?: "web" | "video"): string | undefined {
    const r = this.db
      .prepare(
        `SELECT id FROM explain_jobs WHERE question_id = ? AND status = 'running'${mode ? " AND mode = ?" : ""} LIMIT 1`,
      )
      .get(...(mode ? [questionId, mode] : [questionId]));
    return r ? String(r.id) : undefined;
  }

  // ---- ask jobs（P6 自由提问 → 临时题目；产物是题目，不是讲解） ----
  createAskJob(job: { learnerId?: string; questionId: string; problem: string }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ask_jobs (id, learner_id, question_id, problem, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(id, job.learnerId ?? null, job.questionId, job.problem, now, now);
    return id;
  }

  finishAskJob(id: string, questionId: string): void {
    this.db
      .prepare("UPDATE ask_jobs SET status = 'done', question_id = ?, updated_at = ? WHERE id = ?")
      .run(questionId, new Date().toISOString(), id);
  }

  failAskJob(id: string, error: string): void {
    this.db
      .prepare("UPDATE ask_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error, new Date().toISOString(), id);
  }

  getAskJob(id: string) {
    const r = this.db.prepare("SELECT * FROM ask_jobs WHERE id = ?").get(id);
    if (!r) return undefined;
    return {
      id: String(r.id),
      learnerId: r.learner_id === null ? undefined : String(r.learner_id),
      questionId: String(r.question_id),
      problem: String(r.problem),
      status: String(r.status) as "running" | "done" | "failed",
      error: r.error === null ? undefined : String(r.error),
    };
  }

  /**
   * 同一个孩子问同一道题正在生成时不重复调引擎（plan 要几分钟）。
   * 按 learner 限定：别人的任务不能拿来当自己的轮询句柄（轮询是按归属鉴权的）。
   */
  runningAskJobForQuestion(questionId: string, learnerId?: string): string | undefined {
    const r = this.db
      .prepare("SELECT id FROM ask_jobs WHERE question_id = ? AND status = 'running' AND learner_id IS ? LIMIT 1")
      .get(questionId, learnerId ?? null);
    return r ? String(r.id) : undefined;
  }

  // ---- review cards（P3 SM-2） ----
  upsertReviewCard(learnerId: string, targetKind: "question" | "node", targetId: string, nextReviewAt: string): void {
    this.db
      .prepare(
        `INSERT INTO review_cards (id, learner_id, target_kind, target_id, stage, next_review_at, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(learner_id, target_kind, target_id) DO UPDATE SET
           mastered_at = NULL,
           next_review_at = CASE WHEN review_cards.next_review_at > excluded.next_review_at
                                 THEN excluded.next_review_at ELSE review_cards.next_review_at END`,
      )
      .run(randomUUID(), learnerId, targetKind, targetId, nextReviewAt, new Date().toISOString());
  }

  private rowToReviewCard(r: Record<string, unknown>): ReviewCardRow {
    return {
      id: String(r.id),
      learnerId: String(r.learner_id),
      targetKind: String(r.target_kind) as "question" | "node",
      targetId: String(r.target_id),
      stage: Number(r.stage),
      ease: Number(r.ease),
      nextReviewAt: String(r.next_review_at),
      lapseCount: Number(r.lapse_count),
      masteredAt: r.mastered_at === null ? undefined : String(r.mastered_at),
    };
  }

  getReviewCard(id: string): ReviewCardRow | undefined {
    const r = this.db.prepare("SELECT * FROM review_cards WHERE id = ?").get(id);
    return r ? this.rowToReviewCard(r as Record<string, unknown>) : undefined;
  }

  dueReviewCards(learnerId: string, limit: number): ReviewCardRow[] {
    return this.db
      .prepare(
        `SELECT * FROM review_cards WHERE learner_id = ? AND mastered_at IS NULL AND next_review_at <= ?
         ORDER BY next_review_at LIMIT ?`,
      )
      .all(learnerId, new Date().toISOString(), limit)
      .map((r) => this.rowToReviewCard(r as Record<string, unknown>));
  }

  countDueReviews(learnerId: string): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM review_cards WHERE learner_id = ? AND mastered_at IS NULL AND next_review_at <= ?",
      )
      .get(learnerId, new Date().toISOString());
    return Number(r?.n ?? 0);
  }

  updateReviewCard(id: string, patch: { stage: number; nextReviewAt: string; lapseCount?: number }): void {
    this.db
      .prepare(
        `UPDATE review_cards SET stage = ?, next_review_at = ?${patch.lapseCount !== undefined ? ", lapse_count = ?" : ""} WHERE id = ?`,
      )
      .run(
        ...(patch.lapseCount !== undefined
          ? [patch.stage, patch.nextReviewAt, patch.lapseCount, id]
          : [patch.stage, patch.nextReviewAt, id]),
      );
  }

  masterReviewCard(id: string): void {
    this.db
      .prepare("UPDATE review_cards SET mastered_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  // ---- 家长裁决（判卷抽检队列，P3） ----
  pendingReviewAttempts(learnerId: string, limit = 50) {
    return this.db
      .prepare(
        `SELECT * FROM attempts WHERE learner_id = ? AND needs_review = 1 AND parent_verdict IS NULL
         ORDER BY at DESC LIMIT ?`,
      )
      .all(learnerId, limit)
      .map((r) => this.getAttempt(String((r as Record<string, unknown>).id))!)
      .filter(Boolean);
  }

  setAttemptVerdict(attemptId: string, verdict: "correct" | "incorrect", note?: string): void {
    this.db
      .prepare("UPDATE attempts SET parent_verdict = ?, parent_note = ?, needs_review = 0, correct = ? WHERE id = ?")
      .run(verdict, note ?? null, verdict === "correct" ? 1 : 0, attemptId);
  }

  correctMistake(mistakeId: string, newRootNodeId?: string): void {
    this.db
      .prepare(
        `UPDATE mistakes SET corrected_by_parent = 1${newRootNodeId ? ", root_node_id = ?" : ""} WHERE id = ?`,
      )
      .run(...(newRootNodeId ? [newRootNodeId, mistakeId] : [mistakeId]));
  }

  /** 近 N 天逐日作答统计（家长趋势） */
  dailyStats(learnerId: string, days: number): { date: string; attempts: number; correct: number; hints: number }[] {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT substr(at, 1, 10) AS d,
                COUNT(*) AS attempts,
                SUM(correct) AS correct,
                SUM(CASE WHEN hint_level_used > 0 THEN 1 ELSE 0 END) AS hints
         FROM attempts WHERE learner_id = ? AND at >= ? GROUP BY d ORDER BY d`,
      )
      .all(learnerId, since);
    return rows.map((r) => ({
      date: String((r as Record<string, unknown>).d),
      attempts: Number((r as Record<string, unknown>).attempts),
      correct: Number((r as Record<string, unknown>).correct),
      hints: Number((r as Record<string, unknown>).hints),
    }));
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
