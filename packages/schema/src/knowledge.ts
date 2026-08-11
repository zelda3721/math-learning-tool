import { FigureSpecSchema } from "./figure.js";
import { z } from "zod";
import { StageIdSchema } from "./stage.js";

export const StageInfoSchema = z
  .object({
    id: StageIdSchema,
    name: z.string(),
    ageRange: z.string().optional(),
    order: z.number(),
    accent: z.string().optional(),
    oneLine: z.string().optional(),
  })
  .passthrough();
export type StageInfo = z.infer<typeof StageInfoSchema>;

export const StrandInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    color: z.string().optional(),
    icon: z.string().optional(),
    oneLine: z.string().optional(),
  })
  .passthrough();
export type StrandInfo = z.infer<typeof StrandInfoSchema>;

export const EvolveLinkSchema = z.object({ to: z.string(), how: z.string() });
export type EvolveLink = z.infer<typeof EvolveLinkSchema>;

export const ApplicationSchema = z.object({
  title: z.string(),
  detail: z.string(),
  frontier: z.boolean().optional(),
  industry: z.string().optional(),
});
export type Application = z.infer<typeof ApplicationSchema>;

/** 误概念一等公民（设计 §06）；旧数据是 string[]，由 KnowledgeNodeSchema 归一化 */
export const MisconceptionSchema = z.object({
  id: z.string(),
  desc: z.string(),
  signals: z.array(z.string()),
  probeQuestionIds: z.array(z.string()).optional(),
});
export type Misconception = z.infer<typeof MisconceptionSchema>;

export const SourceSchema = z.object({ title: z.string(), url: z.string().optional() });
export type Source = z.infer<typeof SourceSchema>;

const RawNodeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    nameEn: z.string().optional(),
    stage: StageIdSchema,
    strand: z.string(),
    lane: z.number().optional(),
    order: z.number().optional(),
    summary: z.string(),
    whatIsIt: z.string().optional(),
    why: z.string().optional(),
    bigPicture: z.string().optional(),
    prerequisites: z.array(z.string()).default([]),
    evolvesTo: z.array(EvolveLinkSchema).default([]),
    relatedTo: z.array(z.string()).default([]),
    applications: z.array(ApplicationSchema).default([]),
    misconceptions: z.array(z.union([z.string(), MisconceptionSchema])).default([]),
    keywords: z.array(z.string()).optional(),
    status: z.enum(["ai-generated", "ai-bridge", "verified"]).default("ai-generated"),
    sources: z.array(SourceSchema).default([]),
  })
  .passthrough();

/** 归一化后的知识节点：misconceptions 一律为对象（string 旧格式自动升级） */
export const KnowledgeNodeSchema = RawNodeSchema.transform((node) => ({
  ...node,
  misconceptions: node.misconceptions.map((m, i) =>
    typeof m === "string" ? { id: `${node.id}-misc-${i + 1}`, desc: m, signals: [] } : m,
  ),
}));
export type KnowledgeNode = z.infer<typeof KnowledgeNodeSchema>;

export const GraphSchema = z
  .object({
    stages: z.array(StageInfoSchema),
    strands: z.array(StrandInfoSchema),
    nodes: z.array(KnowledgeNodeSchema),
    provenance: z.unknown().optional(),
  })
  .passthrough();
export type Graph = z.infer<typeof GraphSchema>;

export const ProblemMethodSchema = z.object({ name: z.string(), idea: z.string() });
export type ProblemMethod = z.infer<typeof ProblemMethodSchema>;

const RawProblemTypeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    category: z.string().optional(),
    stage: StageIdSchema,
    example: z.string(),
    essence: z.string(),
    methods: z.array(ProblemMethodSchema).default([]),
    nodes: z.array(z.string()).default([]),
    evolveNote: z.string().optional(),
    evolveNode: z.string().optional(),
    unifiedBy: z.object({ node: z.string().optional(), note: z.string() }).optional(),
    keywords: z.array(z.string()).optional(),
  })
  .passthrough();

/** 归一化后的题型：旧字段 evolveNote/evolveNode 升级为 unifiedBy（统一之路） */
export const ProblemTypeSchema = RawProblemTypeSchema.transform((pt) => {
  const { evolveNote, evolveNode, ...rest } = pt;
  return {
    ...rest,
    unifiedBy:
      pt.unifiedBy ??
      (evolveNote !== undefined ? { node: evolveNode, note: evolveNote } : undefined),
  };
});
export type ProblemType = z.infer<typeof ProblemTypeSchema>;

export const ProblemTypesSchema = z.array(ProblemTypeSchema);

/** 题目：上传材料抽取 + 手工录入（P1a 起） */
export const QuestionSchema = z.object({
  id: z.string(),
  problemTypeId: z.string().optional(),
  nodeIds: z.array(z.string()),
  level: z.enum(["elementary_lower", "elementary_upper", "middle", "high", "advanced"]),
  stem: z.string(),
  options: z.array(z.string()).optional(),
  answer: z.string(),
  answerType: z.enum(["numeric", "expression", "steps"]),
  analysis: z.string().optional(),
  /**
   * 配图规格（几何题）。存的是点线角与约束，不是位图——
   * 坐标由求解器算出并逐条回代验证，图与题干因此不可能对不上，
   * 变式改数字时图也会自动跟着变。见 figure.ts。
   */
  figure: FigureSpecSchema.optional(),
  difficulty: z.number().int().min(1).max(5),
  source: z.object({
    file: z.string().optional(),
    lecture: z.string().optional(),
    role: z.enum(["upload", "teacher", "student", "manual", "generated"]),
  }),
  variantOf: z.string().optional(),
  contentHash: z.string(),
  status: z.enum(["extracted", "verified"]),
});
export type Question = z.infer<typeof QuestionSchema>;
