import { MASTERY_PARAMS, type VerificationLevel } from "@mathtutor/schema";
import type { MasteryRow } from "./repo.js";

export type MasteryBand = "dim" | "glow" | "lit";

/**
 * 一个节点的证据统计（由 `evidence.ts` 从作答历史推导，不落库）。
 * 点亮判据要用它——只有 p 和次数时，同一道题重交三次就能点亮。
 */
export interface EvidenceStats {
  /** 计入掌握度的作答数（同题同日只算第一次） */
  counted: number;
  /** 独立证据：首次见的题、零提示、作答前没看过这道题的解析、且是题目主节点 */
  independent: number;
  /** 独立证据覆盖的不同题数 */
  distinctQuestions: number;
  /** 独立证据跨了几天（同一天为 0） */
  spanDays: number;
  /** 至少有一条独立证据发生在孩子第一次见这道题时 */
  hasFirstSeen: boolean;
}

/** 独立证据够不够点亮（宪法第 1 条） */
export function litByEvidence(stats: EvidenceStats | undefined): boolean {
  if (!stats) return false;
  return (
    stats.independent >= MASTERY_PARAMS.litThresholdIndependent &&
    stats.distinctQuestions >= MASTERY_PARAMS.litThresholdDistinctQuestions &&
    stats.spanDays >= MASTERY_PARAMS.litThresholdSpanDays &&
    stats.hasFirstSeen
  );
}

/**
 * 这条证据能不能进掌握度（宪法第 5 条：未经验证的知识不承重）。
 *
 * `ai_unverified`（作文、口语、开放回答）只作为练习记录与建议，绝不点亮星图。
 * 这不是"少算一点"：一个不该亮的星亮起来，孩子会以为自己会了，
 * 家长也无从分辨——而且事后没有任何数据能把它挑出来。
 */
export function countsTowardMastery(verification: VerificationLevel): boolean {
  return verification !== "ai_unverified";
}

/** 无证据时间衰减：p 沿半衰期向 p₀ 回归（读时计算，存储保持原始 p） */
export function effectiveP(row: Pick<MasteryRow, "p" | "lastEvidenceAt">, now = new Date()): number {
  if (!row.lastEvidenceAt) return row.p;
  const days = Math.max(0, (now.getTime() - Date.parse(row.lastEvidenceAt)) / 86400_000);
  const decay = Math.pow(0.5, days / MASTERY_PARAMS.halfLifeDays);
  return MASTERY_PARAMS.initialP + (row.p - MASTERY_PARAMS.initialP) * decay;
}

/**
 * 单次作答的掌握度更新（宪法：hintLevelUsed 计入权重）。
 * 固定参数启发式——可解释、可手调，永不宣称精准诊断。
 */
export function applyAttempt(
  current: { p: number; evidenceN: number } | undefined,
  correct: boolean,
  hintLevelUsed: 0 | 1 | 2 | 3,
  /**
   * 额外的增益折扣（0..1）。用在「作答前已经看过这道题的解析」上：
   * 那一次答对是回忆，不是理解，能给一点正向反馈，但不该按满额计入。
   * 答错的扣分不受影响。
   */
  extraGainFactor = 1,
): { p: number; evidenceN: number } {
  const p = current?.p ?? MASTERY_PARAMS.initialP;
  const evidenceN = (current?.evidenceN ?? 0) + 1;
  if (correct) {
    const gain = MASTERY_PARAMS.correctGain * MASTERY_PARAMS.hintDiscount[hintLevelUsed] * extraGainFactor;
    return { p: p + gain * (1 - p), evidenceN };
  }
  return { p: p * MASTERY_PARAMS.wrongDecay, evidenceN };
}

/**
 * 星图分档：暗 / 微光 / 点亮。
 *
 * 点亮要同时满足两件事：**掌握度够高**，以及**独立证据够硬**（不同题、隔天、
 * 未见题上零提示做对）。
 *
 * `stats` 缺失一律按**零独立证据**处理，最多到微光。早先缺 stats 时退回
 * 「p 够高 + 次数够」的旧判据，而调用方普遍写成 `evidence.get(nodeId)`——
 * 这个节点一条独立证据都没有时恰好就是 undefined，于是"没有独立证据"反而能点亮。
 * 参数保留可选只是为了让 `evidence.get()` 的结果能直接传进来，不是允许省略。
 */
export function masteryBand(p: number, evidenceN: number, stats: EvidenceStats | undefined): MasteryBand {
  const enoughP = p >= MASTERY_PARAMS.litThresholdP && evidenceN >= MASTERY_PARAMS.litThresholdEvidence;
  if (enoughP && litByEvidence(stats)) return "lit";
  if (p >= MASTERY_PARAMS.dimThresholdP) return "glow";
  return "dim";
}
