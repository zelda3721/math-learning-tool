import { z } from "zod";
import { EducationLevelSchema } from "./stage.js";

export const LearnerSchema = z.object({
  id: z.string(),
  name: z.string(),
  level: EducationLevelSchema,
  prefs: z.record(z.unknown()).optional(),
});
export type Learner = z.infer<typeof LearnerSchema>;

export const AttemptSourceSchema = z.enum(["daily", "probe", "variant", "explore"]);

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
