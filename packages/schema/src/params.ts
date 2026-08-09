/**
 * 首版默认参数（设计 §06「首版默认参数」表）。
 * 全部可调，仅为开工基线；固定参数启发式——永不对外宣称「精准诊断」。
 */
export const MASTERY_PARAMS = {
  /** 初始掌握度 p₀ */
  initialP: 0.3,
  /** 答对更新：p ← p + gain·(1−p) */
  correctGain: 0.25,
  /** 提示折扣：按 hintLevelUsed 0-3 索引 */
  hintDiscount: [1.0, 0.8, 0.5, 0.2] as const,
  /** 答错更新：p ← p × decay */
  wrongDecay: 0.6,
  /** 无证据时间衰减半衰期（天），p 向 p₀ 回归 */
  halfLifeDays: 30,
  /** 节点点亮判据 */
  litThresholdP: 0.7,
  litThresholdEvidence: 3,
  /** 星图分档：< dim 暗 / dim..lit 微光 / ≥ lit 点亮 */
  dimThresholdP: 0.4,
  /** 归因候选阈值：祖先节点 p < 该值或 evidenceN = 0 */
  rootCandidateThresholdP: 0.5,
} as const;

/** SM-2 简化变体：间隔天数表；答错回退 2 级、lapse+1 */
export const REVIEW_PARAMS = {
  intervalsDays: [1, 2, 4, 7, 15, 30] as const,
  wrongStagePenalty: 2,
} as const;
