import { MASTERY_PARAMS } from "@mathtutor/schema";
import type { MasteryRow } from "./repo.js";

export type MasteryBand = "dim" | "glow" | "lit";

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
): { p: number; evidenceN: number } {
  const p = current?.p ?? MASTERY_PARAMS.initialP;
  const evidenceN = (current?.evidenceN ?? 0) + 1;
  if (correct) {
    const gain = MASTERY_PARAMS.correctGain * MASTERY_PARAMS.hintDiscount[hintLevelUsed];
    return { p: p + gain * (1 - p), evidenceN };
  }
  return { p: p * MASTERY_PARAMS.wrongDecay, evidenceN };
}

/** 星图分档：暗 / 微光 / 点亮（点亮还要求最少证据数——理解由行为验证） */
export function masteryBand(p: number, evidenceN: number): MasteryBand {
  if (p >= MASTERY_PARAMS.litThresholdP && evidenceN >= MASTERY_PARAMS.litThresholdEvidence)
    return "lit";
  if (p >= MASTERY_PARAMS.dimThresholdP) return "glow";
  return "dim";
}
