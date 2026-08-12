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
  /**
   * 答案是模型自己解出来的，材料里并没有印。
   *
   * 学生版讲义不给答案，抽取时模型会按提示自己算一个——而它算得不稳：
   * 同一道数三角形的题两次分别给出 48 和 84。这种数进了库不标记出来，
   * 就再也分不清哪些答案有出处、哪些是猜的。
   * 孩子做对了被判错，他会开始怀疑自己而不是怀疑系统——这是最坏的一种错，
   * 所以这类题在家长核对之前不进练习队列（见 questions.ts 的 practiceReady）。
   */
  answerUnverified: z.boolean().optional(),
  analysis: z.string().optional(),
  /**
   * 原题原图：从讲义页上裁下来的那一块，孩子做题时看的就是它。
   *
   * 这是配图的**主表示**。原因很实在：它就是原图，不存在重新理解的风险；
   * 而由模型转写的「点线角 + 约束」再好，也是二手的——我们已经见过它把
   * 图画成上下颠倒、见过它对着数图形的网格给出 52 个点。
   *
   * 只存文件名，文件在 config.figuresDir（/media/figures，不进 git）。
   */
  figureImage: z.string().optional(),
  /**
   * 【解析】里那张图——教师版常在解析里再画一张：割补怎么割、阴影怎么挪、
   * 辅助线画在哪。它是**真人老师画的数形结合**，比我们生成的可靠。
   *
   * 但它不是题面的一部分：那张图往往就是解法本身
   * （「所求阴影部分面积等于下图中阴影部分面积」——图一给出来，这道题就没了）。
   * 所以它**绝不下发给做题中的孩子**，只在讲解时用。
   */
  analysisImage: z.string().optional(),
  /**
   * 配图规格（几何题）：点线角与约束，坐标由求解器算出并逐条回代验证。
   *
   * 它的用处是**动**——讲解时要高亮某条边、要割补、要在变式里跟着数字变，
   * 这些位图都做不到。所以它是按需转写的增强，不是入库时必须有的东西：
   * 抽取阶段只留原图，等到真要做讲解动画时再从原图转过来，
   * 转出来还要与原图核对一致。
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
