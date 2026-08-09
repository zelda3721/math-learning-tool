// 移植自 math-wiki src/types.ts（原样拷入，未改动语义）
// ───────────────────────────────────────────────────────────────
// 数据模型（受 Karpathy「LLM Wiki」启发：每个知识点是一张可互链的页，
// 关系即交叉引用；sources/status 让「用数据验证与扩展」成为一等公民）
// ───────────────────────────────────────────────────────────────

export type StageId = 'primary' | 'junior' | 'senior' | 'university'
export type StrandId = 'number-algebra' | 'geometry' | 'stats-prob' | 'thinking'

/** 学段：小学 / 初中 / 高中 / 大学·前沿 */
export interface Stage {
  id: StageId
  name: string
  ageRange: string
  order: number
  accent: string
  oneLine: string
}

/** 主线（对齐 2022 义务教育数学课标四领域） */
export interface Strand {
  id: StrandId
  name: string
  color: string
  icon: string
  oneLine: string
}

/** 演化链接：这个知识在更高学段「长成」什么，以及如何长成的 */
export interface EvolveLink {
  to: string
  how: string
}

/** 真实世界 / 科学中的用途；frontier 标记前沿科研应用 */
export interface Application {
  title: string
  detail: string
  frontier?: boolean
  /** 对应的行业（如十五五重点产业：通用人工智能、量子信息、脑机接口…） */
  industry?: string
}

/** 出处（用于「用数据验证 / 溯源」） */
export interface Source {
  title: string
  url?: string
}

/** 一个知识点 = 进化树上的一个节点 = 一张 wiki 页 */
export interface KnowledgeNode {
  id: string
  name: string
  nameEn?: string
  stage: StageId
  strand: StrandId
  /** 同一主线内的子行，用于布局避免重叠 */
  lane: number
  /** 同一学段内从左到右的学习先后 */
  order: number

  summary: string
  whatIsIt: string
  why: string
  /** 在整体框架中的位置（承接谁、通向谁） */
  bigPicture: string

  prerequisites: string[]
  evolvesTo: EvolveLink[]
  applications: Application[]
  relatedTo: string[]
  misconceptions?: string[]
  /** 题目定位用的关键词/别名（离线匹配）；可选，缺省时从名称/简介派生 */
  keywords?: string[]

  /** 'ai-generated' | 'ai-bridge' | 'verified' … 内容校验状态 */
  status?: string
  sources?: Source[]
}

export interface Provenance {
  groundedOn: string[]
  standards: string[]
  note: string
}

/** 一种解法（名称 + 思路） */
export interface ProblemMethod {
  name: string
  idea: string
}

/** 题型：一类「用某些知识点去解决」的问题（如鸡兔同笼） */
export interface ProblemType {
  id: string
  name: string
  category: string
  stage: StageId
  example: string
  /** 这类问题的本质 */
  essence: string
  /** 常用解法 */
  methods: ProblemMethod[]
  /** 关联的知识节点 id（定位到知识树） */
  nodes: string[]
  /** 将来如何被更高级方法统一解决 */
  evolveNote?: string
  evolveNode?: string
  keywords?: string[]
}

export interface Graph {
  stages: Stage[]
  strands: Strand[]
  nodes: KnowledgeNode[]
  provenance?: Provenance
  stats?: unknown
  lintReport?: unknown
}
