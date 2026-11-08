import { SubjectRegistry, type Judge, type JudgeVerdict } from "@mathtutor/core";
import { mathSubject } from "@mathtutor/subject-math";
import { englishSubject } from "@mathtutor/subject-english";
import type { Question, VerificationLevel } from "@mathtutor/schema";
import type { Knowledge } from "@mathtutor/knowledge";

/**
 * 学科装配处：**唯一**把学科包登记进内核的地方。
 *
 * 加一门学科只改这一行 register——这正是阶段 1 要证明的事。
 */
export function createSubjectRegistry(): SubjectRegistry {
  const registry = new SubjectRegistry();
  registry.register(mathSubject);
  registry.register(englishSubject);
  return registry;
}

/** 懒加载的默认装配：没显式注入注册表的地方（含单测）用它，装配逻辑仍然只有一份 */
let defaultRegistry: SubjectRegistry | null = null;
export function getSubjectRegistry(): SubjectRegistry {
  defaultRegistry ??= createSubjectRegistry();
  return defaultRegistry;
}

/**
 * 这道题属于哪个学科：看它挂的第一个知识节点。
 *
 * 退到 "math" 而不是抛错：题库里存在 nodeIds 为空的临时题（提问生成的题），
 * 那些题历史上就是按数学判的，改成报错等于让一条能用得通的路突然坏掉。
 */
/**
 * 图谱里的 `subject` 写法 → 学科包 id。
 *
 * 英语图历史上写的是 `"english"`（节点 id 前缀 `en:`），而学科包 id 是 `"en"`。
 * 不认这个别名，英语题按节点归属解析出的学科是 `"english"`，注册表里查不到，
 * 于是每道英语题都落到"没有判卷器、交给家长"——语法题接进来也判不了。
 */
const SUBJECT_ID_ALIASES: Record<string, string> = { english: "en" };

export function subjectOf(
  question: Pick<Question, "nodeIds"> & { answerLang?: Question["answerLang"] },
  knowledge: Knowledge,
): string {
  /*
   * 答案必须用英文写出来的题，按英语判：判的是"你会不会用英语表达"，
   * 而不是"这个数算得对不对"。判卷器不同，证据等级也不同（reference）。
   */
  if (question.answerLang === "en") return "en";
  for (const nodeId of question.nodeIds) {
    const node = knowledge.index.getNode(nodeId);
    if (node) return SUBJECT_ID_ALIASES[node.subject] ?? node.subject;
  }
  return "math";
}

/** 题型 → 内核 itemType id（`math.numeric` / `en.gap-fill` …） */
export function itemTypeOf(
  subject: string,
  question: Pick<Question, "answerType"> & { answerLang?: Question["answerLang"] },
): string {
  // 英文作答的题不是数学那种 numeric/expression，走英语包里的文本类题型
  if (question.answerLang === "en") return "en.vocab-card";
  /*
   * 英语题（语法填空、单句改错）的答案是文字，题型只有一种落点：
   * `en.gap-fill`。它的参考答案支持 `is / 's` 这种多写法，判起来仍是完全确定的。
   */
  if (subject === "en") return "en.gap-fill";
  return `${subject}.${question.answerType}`;
}

export interface JudgedAnswer {
  correct: boolean;
  method: string;
  verification: VerificationLevel;
  feedback?: string;
  /** 没有判卷器时 false：调用方据此转家长确认，而不是随便判一个对错 */
  hasJudge: boolean;
}

/**
 * 判一道题。
 *
 * 查不到判卷器时**不判**：correct=false、method="pending"、verification 保持
 * `ai_unverified`（连 AI 判断都没有，只有一条"没人能判"）。这是宪法第 5 条的本意——
 * 宁可交给人，也不要让一条无依据的判定进掌握度。
 */
export async function judgeAnswer(
  registry: SubjectRegistry,
  knowledge: Knowledge,
  question: Question,
  response: string,
): Promise<JudgedAnswer> {
  const subject = subjectOf(question, knowledge);
  const judge: Judge | undefined =
    registry.judgeFor(subject, itemTypeOf(subject, question)) ?? registry.judgeFor(subject);
  if (!judge) {
    return {
      correct: false,
      method: "pending",
      verification: "ai_unverified",
      feedback: "这道题暂时没有判卷器，已交给家长确认",
      hasJudge: false,
    };
  }
  const verdict: JudgeVerdict = await judge.judge({
    stem: question.stem,
    reference: question.answer,
    options: question.options,
    response,
    answerUnique: question.answerUnique,
  });
  return {
    correct: verdict.correct,
    method: verdict.method,
    verification: verdict.verification,
    feedback: verdict.feedback,
    hasJudge: true,
  };
}
