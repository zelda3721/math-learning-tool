import { z } from "zod";

/**
 * SceneSpec（Visual IR，设计 §05 讲解双模式）：引擎 Solve→Verify→Direct 的产物，
 * 是「讲解数据」的一等契约——Web 播放器（模式 A）与 Manim 编译器（模式 B）共同消费。
 * 结构刻意宽容（passthrough）：引擎的确定性 lowering 会携带丰富的内部字段，
 * 这里只锁定播放器渲染所依赖的骨架。
 */

export const VisualObjectSchema = z
  .object({
    id: z.string(),
    primitive: z.string(),
    params: z.record(z.unknown()).default({}),
    label: z.string().optional(),
    meaning: z.string().optional(),
  })
  .passthrough();
export type VisualObject = z.infer<typeof VisualObjectSchema>;

export const SceneActionSchema = z
  .object({
    op: z.string(),
  })
  .passthrough();
export type SceneAction = z.infer<typeof SceneActionSchema>;

export const SceneBeatSchema = z
  .object({
    role: z.string().optional(),
    actions: z.array(SceneActionSchema).default([]),
    teaching_line: z.string().optional(),
    attention_target: z.string().optional(),
  })
  .passthrough();
export type SceneBeat = z.infer<typeof SceneBeatSchema>;

export const SceneSpecSchema = z
  .object({
    visual_thesis: z.string().optional(),
    essence_rationale: z.string().optional(),
    visual_objects: z.array(VisualObjectSchema).default([]),
    scenes: z.array(SceneBeatSchema).default([]),
    grounding_source: z.string().optional(),
  })
  .passthrough();
export type SceneSpec = z.infer<typeof SceneSpecSchema>;
