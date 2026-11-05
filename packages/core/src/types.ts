import type { VerificationLevel } from "@mathtutor/schema";

/**
 * 学科包的契约（docs/PLAN.md 第三部分）。
 *
 * 内核只认这些形状，不认"数学"或"英语"。一个学科要接进来，就实现这个接口、
 * 在注册表里登记一次；内核一行不用改。
 */

/** 题型：学生怎么作答，决定了课堂与判卷怎么接待它 */
export interface ItemTypeDef {
  /** 学科内唯一，约定带学科前缀：`math.numeric`、`en.vocab-card` */
  id: string;
  subject: string;
  name: string;
  /**
   * 作答形态。刻意用枚举而不是自由字符串：
   * 每多一种，课堂 UI、输入控件、判卷回落路径都要各多一条分支，
   * 而这三种地方最容易漏改。
   */
  answerMode: "numeric" | "expression" | "steps" | "text" | "spoken" | "essay";
}

export interface JudgeInput {
  stem: string;
  /** 参考答案。可空——开放题（作文、口语）本来就没有唯一对错 */
  reference?: string;
  options?: string[];
  /** 学生这次写的/说的（口语由 ASR 转写后进来） */
  response: string;
  /**
   * 参考答案是否唯一（巧填算符、数阵图这类答案不唯一）。
   * `false` 时判卷器「对不上」只能转家长确认，不能判错——
   * 把写出另一种正确解法的孩子判错，是最伤的一种错。
   */
  answerUnique?: boolean;
}

export interface JudgeVerdict {
  correct: boolean;
  /** 判卷方法，进日志与家长中心（家长要看得懂"凭什么这么判"） */
  method: string;
  /**
   * 这次判定凭什么算数。**必须由判卷器自己声明，内核不替它猜**：
   * 默认成 executable 是最坏的失误——一条 AI 判断会被当成可执行验证写进掌握度。
   */
  verification: VerificationLevel;
  /** 给孩子的反馈（可选；口语/作文这类主要靠它） */
  feedback?: string;
}

export interface Judge {
  id: string;
  subject: string;
  /** 这个判卷器能判哪些题型（ItemTypeDef.id） */
  itemTypes: string[];
  judge(input: JudgeInput): JudgeVerdict | Promise<JudgeVerdict>;
}

export interface VerifierDef {
  id: string;
  subject: string;
  /**
   * `executable` = 有可执行手段验算（SymPy、单位、仿真）；
   * `reference` = 有标准答案或证据能在原文定位。
   * 两者都计入掌握度；`ai_unverified` 不是验证器，是"没有验证器"时的诚实标注。
   */
  kind: "executable" | "reference";
}

/** 视觉词汇：图元按学科分命名空间（`phys.force_arrow`），播放器据此找渲染器 */
export interface VisualVocabEntry {
  primitive: string;
  subject: string;
}

/** 一个学科包（subjects/<subject>/） */
export interface SubjectPackage {
  id: string;
  name: string;
  itemTypes: ItemTypeDef[];
  judges: Judge[];
  verifiers?: VerifierDef[];
  visuals?: VisualVocabEntry[];
}
