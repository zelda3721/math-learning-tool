/**
 * 防喂答案：把本课答案从任何要下发的上下文里硬剔掉。
 *
 * 这是教学宪法第 2 条（永不喂答案）在代码里的落地。它不是"提示模型别说答案"——
 * 那种要求靠不住：模型会换个说法、会在下一句里不经意提回来。这里做的是**硬剔除**：
 * 上下文送出去之前，答案就已经不在了。
 *
 * 放在内核而不是课堂里，是因为它跟学科、跟场景无关：课堂提问要用它，
 * 教材组课也要用它（旁白里出现答案＝把题提前做完了），将来口语对练同样要用。
 * 两边各写一份，迟早会出现"课堂剔了、另一处没剔"的漏洞。
 *
 * 两条细节是踩出来的：
 * - **数字必须按整词匹配**。答案是 3 时，"12 个苹果"里的 3 不能被抹掉，
 *   而"还剩 3 个"必须被抹掉。按子串替换会把前者也毁掉，孩子看到的题干就变了。
 * - **短答案不剔**。答案是"鸡"这种单字时，整段话会被抹得读不通，
 *   而读不通的上下文比不剔更糟——模型会去猜一个更离谱的答案。
 */

export interface LessonAnswer {
  /** 这一拍（或这道题）的答案文本 */
  answer: string;
}

/** 被剔掉的位置替换成这个，而不是删掉：让人看得出"这里原本有东西" */
export const REDACTED = "［已隐去］";

/** 太短的答案不剔：抹掉单字会把整段话毁掉，反而让模型去猜更离谱的东西 */
const MIN_ANSWER_CHARS = 2;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从一段文字里剔掉答案。返回剔除后的文本与被剔除的次数。
 *
 * 数字按"整词"匹配（前后不能紧邻数字或小数点），文本按原样匹配且要求长度达标。
 */
export function redactAnswers(
  text: string,
  answers: readonly LessonAnswer[],
): { text: string; removed: number } {
  let out = text;
  let removed = 0;

  for (const { answer } of answers) {
    const needle = answer.trim();
    if (!needle) continue;

    const numeric = /^-?\d+(?:\.\d+)?$/.test(needle);
    if (numeric) {
      // 整词匹配：前后不能是数字或小数点，"12.3" 里的 3 不算命中
      const re = new RegExp(`(?<![\\d.])${escapeRegex(needle)}(?![\\d.])`, "g");
      out = out.replace(re, () => {
        removed += 1;
        return REDACTED;
      });
    } else if (needle.length >= MIN_ANSWER_CHARS) {
      const re = new RegExp(escapeRegex(needle), "g");
      out = out.replace(re, () => {
        removed += 1;
        return REDACTED;
      });
    }
  }

  return { text: out, removed };
}

/** 上下文里是否还残留答案——门禁用：剔除函数写错了要能当场发现 */
export function leaksAnswer(text: string, answers: readonly LessonAnswer[]): boolean {
  return redactAnswers(text, answers).removed > 0;
}

/**
 * 组装暂停提问时的上下文。
 *
 * 只取**到当前拍为止**的讲解句，再整体剔除答案：提前把后面的拍也塞进去，
 * 等于把孩子还没看到的推理一起给了他。
 */
export function buildPauseContext(
  teachingLines: readonly string[],
  upToBeat: number,
  answers: readonly LessonAnswer[],
): string {
  const upto = Math.max(0, Math.min(teachingLines.length - 1, Math.floor(upToBeat)));
  const joined = teachingLines
    .slice(0, upto + 1)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return redactAnswers(joined, answers).text;
}
