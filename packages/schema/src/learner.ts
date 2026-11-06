import { z } from "zod";
import { EducationLevelSchema } from "./stage.js";

export const LearnerSchema = z.object({
  id: z.string(),
  name: z.string(),
  level: EducationLevelSchema,
  prefs: z.record(z.unknown()).optional(),
});
export type Learner = z.infer<typeof LearnerSchema>;

/**
 * 这次作答从哪来。
 *
 * `classroom` 是课堂里答的题（阶段 3）：它在**教学流程中间**产生，
 * 与课后练习的区别不只是入口——课堂作答带着"这一拍讲到哪了"的上下文，
 * 将来做归因时要用到。混进 daily 会把两种证据搅成一种，事后分不开。
 */
export const AttemptSourceSchema = z.enum([
  "daily",
  "probe",
  "variant",
  "review",
  "explore",
  "classroom",
]);

/**
 * 证据的验证等级（教学宪法第 5 条：未经验证的知识不承重）。
 *
 * - `executable`  可执行验证：数学（SymPy）、物理（单位与仿真）。计入掌握度。
 * - `reference`   有标准答案，或证据可在原文中定位：词汇、语法、阅读理解。计入掌握度。
 * - `ai_unverified` 只有 AI 的判断：作文、口语、开放回答。**不计入掌握度**，
 *   只作为练习记录和建议，界面上必须明确标注。
 *
 * 为什么这条要在类型上而不是在注释里：一个分数算错了只是这道题的事，
 * 而一条 `ai_unverified` 的证据混进掌握度，会让孩子**不该亮的星亮起来**——
 * 那是在教错人，且事后无从分辨。所以由 `applyAttempt` 的调用方强制判断。
 */
export const VerificationLevelSchema = z.enum(["executable", "reference", "ai_unverified"]);
export type VerificationLevel = z.infer<typeof VerificationLevelSchema>;

export const AttemptSchema = z.object({
  id: z.string(),
  learnerId: z.string(),
  questionId: z.string(),
  answer: z.string(),
  correct: z.boolean(),
  /** 使用的最高提示层级；计入掌握度权重（宪法第 2 条） */
  hintLevelUsed: z.number().int().min(0).max(3),
  source: AttemptSourceSchema,
  durationS: z.number().optional(),
  /** LLM 判卷/生成题 → 家长判卷抽检队列 */
  needsReview: z.boolean().default(false),
  /**
   * 这条证据凭什么算数。缺省 `executable`：在英语包接入之前，
   * 判卷全部来自确定性判卷器，缺省值即事实。
   */
  verification: VerificationLevelSchema.default("executable"),
  parentVerdict: z.enum(["correct", "incorrect"]).optional(),
  parentNote: z.string().optional(),
  at: z.string(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

/** 错因 = 图谱坐标 (rootNodeId, misconceptionId?)，附证据与置信度（宪法第 4 条） */
export const MistakeSchema = z.object({
  id: z.string(),
  attemptId: z.string(),
  learnerId: z.string(),
  questionId: z.string(),
  surface: z.enum(["concept", "procedure", "calculation", "reading"]),
  rootNodeId: z.string(),
  misconceptionId: z.string().optional(),
  /** 归因回溯路径（依据知识链，UI 明示） */
  chain: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  explanationArtifactId: z.string().optional(),
  correctedByParent: z.boolean().default(false),
});
export type Mistake = z.infer<typeof MistakeSchema>;

/** 掌握度：learner_events 的可重放投影（固定参数启发式，永不宣称精准诊断） */
export const MasterySchema = z.object({
  learnerId: z.string(),
  nodeId: z.string(),
  p: z.number().min(0).max(1),
  evidenceN: z.number().int().min(0),
  lastEvidenceAt: z.string().optional(),
});
export type Mastery = z.infer<typeof MasterySchema>;

/** SM-2 变体复习卡：复习 = 同题型换题再练（宪法第 3 条） */
export const ReviewCardSchema = z.object({
  id: z.string(),
  learnerId: z.string(),
  targetKind: z.enum(["question", "node"]),
  targetId: z.string(),
  stage: z.number().int().min(0),
  ease: z.number(),
  nextReviewAt: z.string(),
  lapseCount: z.number().int().min(0),
  masteredAt: z.string().optional(),
});
export type ReviewCard = z.infer<typeof ReviewCardSchema>;

export const LearnerEventSchema = z.object({
  id: z.string(),
  learnerId: z.string(),
  ts: z.string(),
  type: z.enum(["attempt", "review", "video_watched", "diagnosis", "feedback", "probe_result"]),
  payload: z.record(z.unknown()),
});
export type LearnerEvent = z.infer<typeof LearnerEventSchema>;

/** 讲解产物登记：运行时数据（app.sqlite），引用引擎会话，不入 git 知识层 */
export const ExplanationArtifactSchema = z.object({
  id: z.string(),
  questionId: z.string().optional(),
  focusNodeIds: z.array(z.string()),
  engineSessionId: z.string(),
  mode: z.enum(["web", "video"]),
  /** web 模式：SceneSpec 产物 */
  specUrl: z.string().optional(),
  /** video 模式 */
  videoUrl: z.string().optional(),
  subtitleUrl: z.string().optional(),
  /** video=门禁 v2 分级；web=spec 校验全过为 good、带警告为 acceptable */
  quality: z.enum(["good", "acceptable"]),
  contractVersion: z.string(),
  feedbackLabel: z.enum(["good", "bad", "neutral"]).optional(),
  variantPassRate: z.number().min(0).max(1).optional(),
});
export type ExplanationArtifact = z.infer<typeof ExplanationArtifactSchema>;
