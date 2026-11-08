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
  /*
   * 点亮还要有"独立证据"（宪法第 1 条：理解由行为验证，不由观看验证）。
   *
   * 只有次数和阈值时，同一道题重交三次就能点亮——测到的是记忆，不是理解。
   * 独立证据 = 首次见的题 + 零提示 + 作答前没看过这道题的解析 + 题目主节点。
   */
  /** 至少几条独立证据 */
  litThresholdIndependent: 3,
  /** 独立证据至少覆盖几道不同的题（同一道题刷三遍不算） */
  litThresholdDistinctQuestions: 2,
  /** 独立证据至少跨几天（当天连对三题不算隔天还能做出来） */
  litThresholdSpanDays: 1,
  /** 作答前看过这道题的解析时，答对的增益折扣（回忆不是理解） */
  afterAnalysisGainFactor: 0.3,
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
