import type { Question } from "@mathtutor/schema";
import { normalizeText, parseNumeric } from "./grading.js";

/** 提示阶梯 L1→L3（宪法第 2 条：不喂答案，练方法）。 */
export interface HintProvider {
  /** 返回一段提示文本；抛错或返回空时走离线静态兜底 */
  generate(prompt: string): Promise<string>;
}

const STATIC_HINTS: Record<1 | 2 | 3, string> = {
  1: "再读一遍题目：圈出已知的数量和要求的问题，想想它们之间是什么关系？",
  2: "想一想这道题属于哪类问题，可以画个图或列个式子把数量关系摆出来。",
  3: "把第一步先做出来：从已知条件出发，先算出一个中间量，再看离答案还差什么。",
};

export function buildHintPrompt(question: Question, level: 1 | 2 | 3, lastWrongAnswer?: string): string {
  const goal =
    level === 1
      ? "只指出审题关键（该注意哪些条件），绝不涉及解法"
      : level === 2
        ? "只指出方法方向（用什么思路/模型），绝不给出任何计算"
        : "只给出第一步怎么做（列出第一个式子或第一个操作），绝不继续往下算";
  return `你是小学/初中数学老师，给学生一条第 ${level} 级提示。
题目：${question.stem}
${lastWrongAnswer ? `学生刚才的错误答案：${lastWrongAnswer}` : ""}
硬性规则：
1. ${goal}。
2. 绝对禁止出现最终答案或其数值（答案是保密的）。
3. 不超过两句话，用鼓励的语气，面向孩子。
只输出提示本身，不要任何前后缀。`;
}

/** 程序端答案泄漏检测：提示中不得出现最终答案的数值/文本形态（LLM 说了不算） */
export function leaksAnswer(hint: string, question: Question): boolean {
  const normalizedHint = normalizeText(hint);
  const answerNum = parseNumeric(question.answer);
  // 文本型答案用整体包含检测；数字型答案只用带边界的正则
  //（朴素 includes 会把「第126页」误判为泄漏「26」）
  if (answerNum === null) {
    const answerText = normalizeText(question.answer);
    if (answerText.length >= 1 && normalizedHint.includes(answerText)) return true;
  }
  if (answerNum !== null) {
    const forms = [
      String(answerNum),
      answerNum.toFixed(1).replace(/\.0$/, ""),
      answerNum.toFixed(2).replace(/\.?0+$/, ""),
    ];
    for (const f of new Set(forms)) {
      if (f.length >= 1 && new RegExp(`(?<![\\d.])${escapeRegExp(f)}(?![\\d.])`).test(normalizedHint))
        return true;
    }
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function makeHint(
  provider: HintProvider | null,
  question: Question,
  level: 1 | 2 | 3,
  lastWrongAnswer?: string,
): Promise<{ hint: string; source: "llm" | "static" }> {
  if (provider) {
    try {
      const text = (await provider.generate(buildHintPrompt(question, level, lastWrongAnswer))).trim();
      if (text && !leaksAnswer(text, question)) return { hint: text, source: "llm" };
      // 泄漏或空输出：一次重试的价值低（同题同提示词大概率复现），直接静态兜底
    } catch {
      // fall through to static
    }
  }
  return { hint: STATIC_HINTS[level], source: "static" };
}
