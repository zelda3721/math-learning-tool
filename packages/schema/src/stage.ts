import { z } from "zod";

/** 图谱学段：保持 math-wiki 的 4 级不动（避免迁移 75 个节点） */
export const StageIdSchema = z.enum(["primary", "junior", "senior", "university"]);
export type StageId = z.infer<typeof StageIdSchema>;

/** 题目/引擎年级：5 级，与引擎 EducationLevel 对齐 */
export const EducationLevelSchema = z.enum([
  "elementary_lower",
  "elementary_upper",
  "middle",
  "high",
  "advanced",
]);
export type EducationLevel = z.infer<typeof EducationLevelSchema>;

/** 5 级年级 → 4 级图谱学段的静态映射（唯一真源） */
export const STAGE_OF: Record<EducationLevel, StageId> = {
  elementary_lower: "primary",
  elementary_upper: "primary",
  middle: "junior",
  high: "senior",
  advanced: "university",
};
