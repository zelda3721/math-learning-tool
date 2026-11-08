import type { DatabaseSync } from "node:sqlite";
import { readLearnerPrefs, writeLearnerPrefs } from "./learnerPrefs.js";
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

/** 事件 payload 是外部写入的 JSON：坏了一行不该让整个查询抛错 */
function safeJson(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** 本地时间的零点：孩子是"今天"用完了，不是"UTC 今天" */
function localDayStart(at: Date): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
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

  /** 学习者偏好（`learners.prefs_json`）：时长上限、被关掉的模块等 */
  learnerPrefs(id: string): import("./learnerPrefs.js").LearnerPrefs {
    return readLearnerPrefs(this.db, id);
  }

  setLearnerPrefs(id: string, patch: import("./learnerPrefs.js").LearnerPrefs): void {
    writeLearnerPrefs(this.db, id, patch);
  }

  getLearner(id: string): Learner | undefined {
    const r = this.db.prepare("SELECT id, name, level FROM learners WHERE id = ?").get(id);
    return r ? { id: String(r.id), name: String(r.name), level: r.level as EducationLevel } : undefined;
  }

  // ---- attempts ----
  /**
   * `verification` 可省略，缺省 `executable`：在英语包接入之前，判卷全部来自
   * 确定性判卷器，缺省值就是事实。新学科要写 `ai_unverified` 时必须显式传。
   */
  insertAttempt(
    a: Omit<Attempt, "id" | "at" | "verification"> & {
      at?: string;
      verification?: Attempt["verification"];
      /** 谁在作答：缺省孩子本人；家长试做记为 parent，不进掌握度但留痕 */
      actor?: "child" | "parent";
    },
  ): Attempt {
    const id = randomUUID();
    const at = a.at ?? new Date().toISOString();
    const verification = a.verification ?? "executable";
    this.db
      .prepare(
        `INSERT INTO attempts (id, learner_id, question_id, answer, correct, hint_level_used,
          source, duration_s, needs_review, verification, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        verification,
        a.actor ?? "child",
        at,
      );
    return { ...a, id, at, verification, needsReview: a.needsReview };
  }

  /**
   * 证据账本的原料：一次读全部作答（不截断）。
   *
   * 为什么不复用 recentAttempts：那个有 limit，且不带 verification/needs_review/actor，
   * 而这三样正是"这条证据算不算数"的判据。推导在 evidence.ts 里做，这里只负责取数。
   */
  attemptsForEvidence(learnerId: string): {
    questionId: string;
    correct: boolean;
    hintLevelUsed: number;
    at: string;
    source: string;
    verification: string;
    needsReview: boolean;
    actor: string;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT question_id, correct, hint_level_used, at, source, verification, needs_review, actor
         FROM attempts WHERE learner_id = ? ORDER BY at`,
      )
      .all(learnerId);
    return rows.map((r) => ({
      questionId: String(r.question_id),
      correct: Boolean(r.correct),
      hintLevelUsed: Number(r.hint_level_used),
      at: String(r.at),
      source: String(r.source),
      verification: String(r.verification ?? "executable"),
      needsReview: Boolean(r.needs_review),
      actor: String(r.actor ?? "child"),
    }));
  }

  /** 看过的题目解析：questionId → 时刻（升序）。用来区分"回忆"和"理解" */
  analysisViews(learnerId: string): Map<string, string[]> {
    const views = new Map<string, string[]>();
    const rows = this.db
      .prepare(
        `SELECT ts, payload_json FROM learner_events
         WHERE learner_id = ? AND type = 'analysis_view' ORDER BY ts`,
      )
      .all(learnerId);
    for (const r of rows) {
      const payload = safeJson(r.payload_json) as { questionId?: unknown } | null;
      const questionId = typeof payload?.questionId === "string" ? payload.questionId : undefined;
      if (!questionId) continue;
      const list = views.get(questionId) ?? [];
      list.push(String(r.ts));
      views.set(questionId, list);
    }
    return views;
  }

  /** 这道题上一次作答前是否看过解析（决定增益折扣） */
  viewedAnalysisBefore(learnerId: string, questionId: string, at: string): boolean {
    const views = this.analysisViews(learnerId).get(questionId) ?? [];
    return views.some((t) => t <= at);
  }

  /**
   * 今天这道题已经计过几次证据：对错各算各的。
   *
   * 为什么要分开：同一道题一天里最多认「一次错」和「一次对」。
   * - 反复交错答案不再连续 ×0.6 扣分（订正过程本来就被按错扣分，旧口径能把
   *   一颗点亮的星打回暗）；
   * - 但真的订正成功了还是一次真实的作答，不能假装没发生。
   */
  todayAttemptCounts(learnerId: string, questionId: string, at = new Date()): { correct: number; wrong: number } {
    const day = localDayStart(at).toISOString();
    const rows = this.db
      .prepare(
        `SELECT correct, COUNT(*) AS n FROM attempts
         WHERE learner_id = ? AND question_id = ? AND at >= ?
           AND needs_review = 0 AND verification != 'ai_unverified' AND actor = 'child'
         GROUP BY correct`,
      )
      .all(learnerId, questionId, day);
    let correct = 0;
    let wrong = 0;
    for (const r of rows) {
      if (Boolean(r.correct)) correct = Number(r.n);
      else wrong = Number(r.n);
    }
    return { correct, wrong };
  }

  /** 这道题今天是否已经答对（"看过解析再答"的折扣只需要知道这一件事） */
  correctToday(learnerId: string, questionId: string, at = new Date()): boolean {
    const day = localDayStart(at).toISOString();
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM attempts WHERE learner_id = ? AND question_id = ? AND at >= ? AND correct = 1",
      )
      .get(learnerId, questionId, day);
    return Number((r as { n?: number } | undefined)?.n ?? 0) > 0;
  }

  /** 这道题已经拿到过的最高提示级（服务端记账，不信客户端自报） */
  maxHintLevel(learnerId: string, questionId: string): number {
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM learner_events
         WHERE learner_id = ? AND type = 'attempt' AND json_extract(payload_json, '$.kind') = 'hint'
           AND json_extract(payload_json, '$.questionId') = ?`,
      )
      .all(learnerId, questionId);
    let max = 0;
    for (const r of rows) {
      const payload = safeJson(r.payload_json) as { level?: unknown } | null;
      const level = typeof payload?.level === "number" ? payload.level : 0;
      if (level > max) max = level;
    }
    return max;
  }

  /** 这孩子对这道题是否已经"走过一遍"（答对过，或走完了三级提示） */
  workedThrough(learnerId: string, questionId: string): boolean {
    const correct = this.db
      .prepare("SELECT COUNT(*) AS n FROM attempts WHERE learner_id = ? AND question_id = ? AND correct = 1")
      .get(learnerId, questionId);
    if (Number((correct as { n?: number } | undefined)?.n ?? 0) > 0) return true;
    return this.maxHintLevel(learnerId, questionId) >= 3;
  }

  /** 队列项的 kind：探针的来源由服务端按它判定，不信客户端传的 source */  getQueueItem(id: string): { id: string; kind: string; questionId: string } | undefined {
    const r = this.db.prepare("SELECT id, kind, question_id FROM queue_items WHERE id = ?").get(id);
    if (!r) return undefined;
    return { id: String(r.id), kind: String(r.kind), questionId: String(r.question_id) };
  }

  /** 这个孩子一共提过几次题库外的题（家长端"独立性"看板要的数） */
  countAskJobs(learnerId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM ask_jobs WHERE learner_id = ?")
      .get(learnerId);
    return Number((r as { n?: number } | undefined)?.n ?? 0);
  }

  getAttempt(id: string): (Attempt & { at: string; actor?: string }) | undefined {
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
      verification: (r.verification ?? "executable") as Attempt["verification"],
      /** 谁在作答（家长试做记为 parent）：归因判断"这条证据算不算"要用 */
      actor: String(r.actor ?? "child"),
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

  /**
   * 把一个孩子的学习状态清回初始。
   *
   * 场景很实在：题库推倒重建（比如删掉 demo 题、换成真材料）之后，
   * 掌握度、复习卡、错题全都指着不存在的旧题——星图亮着不该亮的星，
   * 复习队列永远在等一道已删除的题。账号本身与登录绑定不动，
   * 只清学习痕迹，孩子重新登录就是一张白纸。
   */
  resetLearnerState(learnerId: string): { table: string; removed: number }[] {
    const tables = [
      "attempts",
      "mastery",
      "learner_events",
      "queue_items",
      "review_cards",
      "mistakes",
      // 转写也算学习痕迹：重置一个孩子就该连"他自己说过的话"一起清掉
      "explore_transcripts",
    ];
    return tables.map((table) => {
      const r = this.db.prepare(`DELETE FROM ${table} WHERE learner_id = ?`).run(learnerId);
      return { table, removed: Number(r.changes) };
    });
  }

  /** 最近的全部作答（含对错与所填答案），供家长端汇总"卡住的题" */
  recentAttempts(learnerId: string, limit = 300) {
    const rows = this.db
      .prepare(
        `SELECT question_id, correct, hint_level_used, answer, at
         FROM attempts WHERE learner_id = ? ORDER BY at DESC LIMIT ?`,
      )
      .all(learnerId, limit);
    return rows.map((r) => ({
      questionId: String(r.question_id),
      correct: Boolean(r.correct),
      hintLevelUsed: Number(r.hint_level_used),
      answer: String(r.answer ?? ""),
      at: String(r.at),
    }));
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

  // ---- 导师长期记忆（可解释、可删、只存本地） ----
  /**
   * 记一条记忆。同一 `dedupeKey` 已有则累加计数并刷新时间——
   * 一件事反复发生不代表要记十条，记一条、数次数才是人读得懂的形态。
   *
   * **删过的条目不再复活**（`WHERE tutor_memories.deleted_at IS NULL`）。
   * 记忆是每轮对话前重新派生的，UPSERT 里那个 `deleted_at = NULL` 曾让家长删掉的记忆
   * 下一次对话就原样回来——"删了就真的不再被召回"这条承诺当场作废。
   * 现在墓碑挡住后续写入：数据再怎么证明同一件事，它也不会重新出现。
   * 家长要恢复某条记忆，只能靠新增一条不同的记忆，不能靠"删错"来碰运气。
   */
  rememberMemory(input: {
    learnerId: string;
    kind: string;
    text: string;
    dedupeKey: string;
    source: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tutor_memories (id, learner_id, kind, text, dedupe_key, hit_count, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(learner_id, dedupe_key) DO UPDATE SET
           text = excluded.text,
           hit_count = tutor_memories.hit_count + 1,
           updated_at = excluded.updated_at
         WHERE tutor_memories.deleted_at IS NULL`,
      )
      .run(randomUUID(), input.learnerId, input.kind, input.text, input.dedupeKey, input.source, now, now);
  }

  /** 召回：默认只给还在用的（软删除的一律不出现） */
  listMemories(learnerId: string, opts: { includeDeleted?: boolean } = {}): {
    id: string;
    kind: string;
    text: string;
    hitCount: number;
    source: string;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
  }[] {
    const rows = (
      opts.includeDeleted
        ? this.db.prepare("SELECT * FROM tutor_memories WHERE learner_id = ? ORDER BY updated_at DESC").all(learnerId)
        : this.db
            .prepare(
              "SELECT * FROM tutor_memories WHERE learner_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC",
            )
            .all(learnerId)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      text: String(r.text),
      hitCount: Number(r.hit_count ?? 1),
      source: String(r.source),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : String(r.deleted_at),
    }));
  }

  /** 家长删记忆：软删除，召回立刻不再出现 */
  forgetMemory(learnerId: string, id: string): boolean {
    const result = this.db
      .prepare("UPDATE tutor_memories SET deleted_at = ? WHERE learner_id = ? AND id = ? AND deleted_at IS NULL")
      .run(new Date().toISOString(), learnerId, id);
    return Number(result.changes ?? 0) > 0;
  }

  // ---- events（append-only；mastery 是它的可重放投影） ----
  appendEvent(learnerId: string, type: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO learner_events (id, learner_id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), learnerId, new Date().toISOString(), type, JSON.stringify(payload));
  }

  /**
   * 读事件（按时间正序）。可传 type 过滤。
   *
   * 补这个方法的原因很实在：`learner_events` 一直是**只写不读**的。
   * 而语义判卷那边写着"模型放行的每一次都记进 learner_events，可审"——
   * 一条没人读得到的审计记录，跟没记没有区别。
   */
  listEvents(
    learnerId: string,
    type?: string,
  ): { id: string; ts: string; type: string; payload: unknown }[] {
    const rows = (
      type
        ? this.db
            .prepare("SELECT * FROM learner_events WHERE learner_id = ? AND type = ? ORDER BY ts")
            .all(learnerId, type)
        : this.db
            .prepare("SELECT * FROM learner_events WHERE learner_id = ? ORDER BY ts")
            .all(learnerId)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      ts: String(r.ts),
      type: String(r.type),
      payload: JSON.parse(String(r.payload_json)),
    }));
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
  /** 同一道题/同一根因的其它形态讲解（用于并排对比：模型直写 vs 固定播放器） */
  siblingExplanations(explanationId: string) {
    const self = this.getExplanation(explanationId);
    if (!self) return [];
    const rows = self.questionId
      ? this.db
          .prepare(
            `SELECT * FROM explanations WHERE question_id = ? AND id != ?
             ORDER BY created_at DESC`,
          )
          .all(self.questionId, explanationId)
      : [];
    const seen = new Set<string>();
    const out: ReturnType<Repo["rowToExplanation"]>[] = [];
    for (const row of rows as Record<string, unknown>[]) {
      const item = this.rowToExplanation(row);
      // 每种形态只留最新一份，避免重复生成把选择器撑满
      if (item.mode === self.mode || seen.has(item.mode)) continue;
      if (!item.specUrl && !item.htmlUrl && !item.videoUrl) continue;
      seen.add(item.mode);
      out.push(item);
    }
    return out;
  }

  /**
   * 人工偏好：哪一份讲得更清楚。
   *
   * 这是最贵也最有价值的标签——门禁只能判「有没有画错」，判不了「讲没讲明白」。
   * 与 grounding_source 一起看，就能回答「模型直写到底比确定性构造器好在哪」。
   */
  setExplanationFeedback(explanationId: string, label: string): boolean {
    const info = this.db
      .prepare("UPDATE explanations SET feedback_label = ? WHERE id = ?")
      .run(label, explanationId);
    return Number(info.changes ?? 0) > 0;
  }

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
    clear_votes: number;
    confusing_votes: number;
  }[] {
    return this.db
      .prepare(
        `SELECT mode,
                COALESCE(grounding_source, 'llm_director') AS source,
                quality,
                COUNT(*) AS count,
                SUM(CASE WHEN feedback_label = 'clear' THEN 1 ELSE 0 END) AS clear_votes,
                SUM(CASE WHEN feedback_label = 'confusing' THEN 1 ELSE 0 END) AS confusing_votes
           FROM explanations
          GROUP BY mode, source, quality
          ORDER BY count DESC`,
      )
      .all() as {
      mode: string;
      source: string;
      quality: string;
      count: number;
      clear_votes: number;
      confusing_votes: number;
    }[];
  }

  insertExplanation(e: {
    id: string;
    questionId?: string;
    focusNodeIds: string[];
    engineSessionId: string;
    mode: "web" | "web_html" | "video";
    specUrl?: string;
    htmlUrl?: string;
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
          spec_url, html_url, video_url, subtitle_url, quality, contract_version,
          grounding_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.questionId ?? null,
        JSON.stringify(e.focusNodeIds),
        e.engineSessionId,
        e.mode,
        e.specUrl ?? null,
        e.htmlUrl ?? null,
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
      mode: String(r.mode) as "web" | "web_html" | "video",
      specUrl: r.spec_url === null || r.spec_url === undefined ? undefined : String(r.spec_url),
      htmlUrl: r.html_url === null || r.html_url === undefined ? undefined : String(r.html_url),
      videoUrl: r.video_url === null ? undefined : String(r.video_url),
      subtitleUrl: r.subtitle_url === null ? undefined : String(r.subtitle_url),
      quality: String(r.quality) as "good" | "acceptable",
      feedbackLabel:
        r.feedback_label === null || r.feedback_label === undefined
          ? undefined
          : String(r.feedback_label),
      groundingSource:
        r.grounding_source === null || r.grounding_source === undefined
          ? undefined
          : String(r.grounding_source),
      contractVersion: String(r.contract_version),
      createdAt: String(r.created_at),
    };
  }

  getExplanation(id: string) {
    const r = this.db.prepare("SELECT * FROM explanations WHERE id = ?").get(id);
    return r ? this.rowToExplanation(r as Record<string, unknown>) : undefined;
  }

  /** 讲解缓存查找：优先同题，其次同根因节点；mode 指定时只命中该模式 */
  findExplanation(
    questionId: string | undefined,
    focusNodeId: string | undefined,
    mode?: "web" | "web_html" | "video",
  ) {
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
    mode?: "web" | "web_html" | "both" | "video";
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

  /** 非致命备注：任务成功了，但有些事该被记下来（如模型那份为何被弃用） */
  noteExplainJob(jobId: string, note: string): void {
    this.db
      .prepare("UPDATE explain_jobs SET note = ?, updated_at = ? WHERE id = ?")
      .run(note.slice(0, 500), new Date().toISOString(), jobId);
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
      note: r.note === null || r.note === undefined ? undefined : String(r.note),
    };
  }

  /**
   * 把久悬未决的 running 任务判死。
   *
   * 任务是 fire-and-forget 的：进程中途重启、或引擎那头彻底没响应，
   * 这条记录就永远停在 running——既挡住同题去重（这道题再也生成不了），
   * 前端也会一直空轮询等一个永远不来的结果。宁可判它失败让人重试。
   */
  reapStaleExplainJobs(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const info = this.db
      .prepare(
        `UPDATE explain_jobs SET status = 'failed', error = ?, updated_at = ?
          WHERE status = 'running' AND created_at < ?`,
      )
      .run("任务久未完成，已判定超时（引擎无响应或进程中途退出）", new Date().toISOString(), cutoff);
    return Number(info.changes ?? 0);
  }

  /** 有 running 讲解任务时避免重复排队（同题同模式去重） */
  runningExplainJobForQuestion(
    questionId: string,
    mode?: "web" | "web_html" | "both" | "video",
  ): string | undefined {
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

  // ---- 阶段测评（前测 / 后测 / 保持率）：单独记账，不进掌握度 ----
  createAssessment(learnerId: string, kind: string, scope: string[], questionIds: string[]): string {
    const id = randomUUID();
    const at = new Date().toISOString();
    this.db
      .prepare("INSERT INTO assessments (id, learner_id, kind, scope_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, learnerId, kind, JSON.stringify(scope), at);
    const insert = this.db.prepare(
      "INSERT INTO assessment_items (id, assessment_id, question_id, position) VALUES (?, ?, ?, ?)",
    );
    questionIds.forEach((qid, i) => insert.run(randomUUID(), id, qid, i));
    return id;
  }

  getAssessment(id: string):
    | { id: string; learnerId: string; kind: string; scope: string[]; createdAt: string; finishedAt: string | null }
    | undefined {
    const r = this.db.prepare("SELECT * FROM assessments WHERE id = ?").get(id);
    if (!r) return undefined;
    return {
      id: String(r.id),
      learnerId: String(r.learner_id),
      kind: String(r.kind),
      scope: JSON.parse(String(r.scope_json)) as string[],
      createdAt: String(r.created_at),
      finishedAt: r.finished_at === null || r.finished_at === undefined ? null : String(r.finished_at),
    };
  }

  listAssessmentItems(assessmentId: string): {
    questionId: string;
    position: number;
    answer: string | null;
    correct: boolean | null;
    answeredAt: string | null;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM assessment_items WHERE assessment_id = ? ORDER BY position")
      .all(assessmentId);
    return rows.map((r) => ({
      questionId: String(r.question_id),
      position: Number(r.position),
      answer: r.answer === null || r.answer === undefined ? null : String(r.answer),
      correct: r.correct === null || r.correct === undefined ? null : Boolean(r.correct),
      answeredAt: r.answered_at === null || r.answered_at === undefined ? null : String(r.answered_at),
    }));
  }

  answerAssessmentItem(assessmentId: string, questionId: string, answer: string, correct: boolean): void {
    this.db
      .prepare("UPDATE assessment_items SET answer = ?, correct = ?, answered_at = ? WHERE assessment_id = ? AND question_id = ?")
      .run(answer, correct ? 1 : 0, new Date().toISOString(), assessmentId, questionId);
  }

  finishAssessment(id: string): void {
    this.db.prepare("UPDATE assessments SET finished_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  listAssessments(learnerId: string, limit = 20): {
    id: string;
    kind: string;
    scope: string[];
    createdAt: string;
    finishedAt: string | null;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM assessments WHERE learner_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(learnerId, limit);
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      scope: JSON.parse(String(r.scope_json)) as string[],
      createdAt: String(r.created_at),
      finishedAt: r.finished_at === null || r.finished_at === undefined ? null : String(r.finished_at),
    }));
  }

  // ---- 英语口语对练（阶段 5） ----
  createSpeakingSession(learnerId: string, scenarioId: string): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO speaking_sessions (id, learner_id, scenario_id, started_at) VALUES (?, ?, ?, ?)")
      .run(id, learnerId, scenarioId, new Date().toISOString());
    return id;
  }

  getSpeakingSession(id: string): { id: string; learnerId: string; scenarioId: string; startedAt: string; endedAt: string | null } | undefined {
    const r = this.db.prepare("SELECT * FROM speaking_sessions WHERE id = ?").get(id);
    if (!r) return undefined;
    return {
      id: String(r.id),
      learnerId: String(r.learner_id),
      scenarioId: String(r.scenario_id),
      startedAt: String(r.started_at),
      endedAt: r.ended_at === null || r.ended_at === undefined ? null : String(r.ended_at),
    };
  }

  endSpeakingSession(id: string): void {
    this.db.prepare("UPDATE speaking_sessions SET ended_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  /** 每一轮对练：role=blocked 时不留原话（和探索对话同一条纪律） */
  insertSpeakingTurn(t: {
    sessionId: string;
    learnerId: string;
    role: "child" | "tutor" | "blocked";
    text?: string;
    latencyMs?: number;
    safetyReason?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO speaking_turns (id, session_id, learner_id, ts, role, text, latency_ms, safety_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        t.sessionId,
        t.learnerId,
        new Date().toISOString(),
        t.role,
        t.role === "blocked" ? "" : (t.text ?? ""),
        t.latencyMs ?? null,
        t.safetyReason ?? null,
      );
  }

  listSpeakingTurns(sessionId: string): { ts: string; role: string; text: string; latencyMs: number | null; safetyReason: string | null }[] {
    const rows = this.db
      .prepare("SELECT ts, role, text, latency_ms, safety_reason FROM speaking_turns WHERE session_id = ? ORDER BY ts")
      .all(sessionId);
    return rows.map((r) => ({
      ts: String(r.ts),
      role: String(r.role),
      text: String(r.text ?? ""),
      latencyMs: r.latency_ms === null || r.latency_ms === undefined ? null : Number(r.latency_ms),
      safetyReason: r.safety_reason === null || r.safety_reason === undefined ? null : String(r.safety_reason),
    }));
  }

  /** 家长看：最近的几次对练（不带内容，内容按 session 单独取） */
  listSpeakingSessions(learnerId: string, limit = 20): { id: string; scenarioId: string; startedAt: string; endedAt: string | null; turns: number }[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.scenario_id, s.started_at, s.ended_at,
                (SELECT COUNT(*) FROM speaking_turns t WHERE t.session_id = s.id) AS turns
         FROM speaking_sessions s WHERE s.learner_id = ? ORDER BY s.started_at DESC LIMIT ?`,
      )
      .all(learnerId, limit);
    return rows.map((r) => ({
      id: String(r.id),
      scenarioId: String(r.scenario_id),
      startedAt: String(r.started_at),
      endedAt: r.ended_at === null || r.ended_at === undefined ? null : String(r.ended_at),
      turns: Number(r.turns ?? 0),
    }));
  }

  // ---- 对话转写（阶段 4；默认关，开不写在一处判断，见 learnerPrefs.recordTranscript） ----
  /** 写一轮转写。`role='blocked'` 时 content 一律空，只留原因——被拦下的原话不落库 */
  insertTranscript(t: {
    learnerId: string;
    role: "user" | "assistant" | "blocked";
    content?: string;
    safetyReason?: string;
    at?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO explore_transcripts (id, learner_id, ts, role, content, safety_reason) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        t.learnerId,
        t.at ?? new Date().toISOString(),
        t.role,
        t.role === "blocked" ? "" : (t.content ?? ""),
        t.safetyReason ?? null,
      );
  }

  /** 家长看：倒序（最近的对话在最上面） */
  listTranscripts(
    learnerId: string,
    limit = 200,
  ): { id: string; ts: string; role: string; content: string; safetyReason: string | null }[] {
    const rows = this.db
      .prepare(
        "SELECT id, ts, role, content, safety_reason FROM explore_transcripts WHERE learner_id = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(learnerId, limit);
    return rows.map((r) => ({
      id: String(r.id),
      ts: String(r.ts),
      role: String(r.role),
      content: String(r.content ?? ""),
      safetyReason: r.safety_reason === null || r.safety_reason === undefined ? null : String(r.safety_reason),
    }));
  }

  /** 家长清空：**物理删除**。转写是"家长自己开的录音"，删掉就该真没了 */
  clearTranscripts(learnerId: string): number {
    const r = this.db.prepare("DELETE FROM explore_transcripts WHERE learner_id = ?").run(learnerId);
    return Number(r.changes ?? 0);
  }

  // ---- AI 判断抽查（宪法第 5 条：ai_unverified 的证据要有人看，但不承重） ----
  /**
   * 列 `verification='ai_unverified'` 的作答，供家长抽查。
   * 不按 needs_review 过滤：这类作答本来就可能不进裁决队列（模型判"对"时
   * needs_review 是 0），只按 needs_review 筛会让家长一条都看不到。
   */
  attemptsByVerification(
    learnerId: string,
    verification: Attempt["verification"],
    limit = 50,
  ): (Attempt & { at: string })[] {
    return this.db
      .prepare("SELECT id FROM attempts WHERE learner_id = ? AND verification = ? ORDER BY at DESC LIMIT ?")
      .all(learnerId, verification, limit)
      .map((r) => this.getAttempt(String((r as Record<string, unknown>).id))!)
      .filter(Boolean);
  }

  /** 家长推翻一条 AI 判断：只标"需复核"，等他自己给出结论，不在这里改判 */
  markAttemptNeedsReview(attemptId: string): boolean {
    const r = this.db
      .prepare("UPDATE attempts SET needs_review = 1 WHERE id = ? AND parent_verdict IS NULL")
      .run(attemptId);
    return Number(r.changes ?? 0) > 0;
  }

  // ---- review cards（P3 SM-2） ----
  /**
   * 建/重置一张复习卡。
   *
   * targetKind 是开放的：`question` / `node` 走组卷器，`vocab` / `reading`
   * 是英语那两条线（词与读物不是图谱节点，进度单独记）。类型放宽是有意的——
   * 每加一条学习线都来改一次签名，等于把"这里会长新东西"写死在类型里。
   */
  upsertReviewCard(learnerId: string, targetKind: string, targetId: string, nextReviewAt: string): void {
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
        `SELECT * FROM review_cards WHERE learner_id = ? AND target_kind IN ('question','node')
         AND mastered_at IS NULL AND next_review_at <= ?
         ORDER BY next_review_at LIMIT ?`,
      )
      .all(learnerId, new Date().toISOString(), limit)
      .map((r) => this.rowToReviewCard(r as Record<string, unknown>));
  }

  /**
   * 按 targetKind 列复习卡（vocab / reading 这些词与读物不是图谱节点，自己一条线）。
   * 与 dueReviewCards 分开：那种"到期的题"会被组卷器直接拿去出题，
   * 混进 vocab 卡就会让组卷器拿到一个查不到的 question id。
   */
  listReviewCardsByKind(learnerId: string, targetKind: string): ReviewCardRow[] {
    return this.db
      .prepare("SELECT * FROM review_cards WHERE learner_id = ? AND target_kind = ?")
      .all(learnerId, targetKind)
      .map((r) => this.rowToReviewCard(r as Record<string, unknown>));
  }

  /** 到期复习只数题：词汇与阅读有自己的入口，不该占"今天有几道复习题"这个数 */
  countDueReviews(learnerId: string): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM review_cards WHERE learner_id = ? AND target_kind IN ('question','node') AND mastered_at IS NULL AND next_review_at <= ?",
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
