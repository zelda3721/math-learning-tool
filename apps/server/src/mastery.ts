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
 * 未见题上零提示做对）。只给 p 和次数时（拿不到证据明细的历史调用）退回旧判据，
 * 但孩子看得见的那些地方都应该把 stats 传进来。
 */
export function masteryBand(p: number, evidenceN: number, stats?: EvidenceStats): MasteryBand {
  const enoughP = p >= MASTERY_PARAMS.litThresholdP && evidenceN >= MASTERY_PARAMS.litThresholdEvidence;
  if (enoughP && (stats === undefined || litByEvidence(stats))) return "lit";
  if (p >= MASTERY_PARAMS.dimThresholdP) return "glow";
  return "dim";
}
