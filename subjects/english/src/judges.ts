import type { ItemTypeDef, Judge, JudgeVerdict } from "@mathtutor/core";

/**
 * 英语学科包的题型与判卷器（骨架版）。
 *
 * 这一版只做**有标准答案**的题型，判卷逻辑简单到可以一眼看穿——
 * 它的作用是验证内核契约成立，不是把英语教学做出来。
 * 写作、口语这类没有唯一对错的，判卷器必须返回 `ai_unverified`（见 judges.ts）。
 */

export const ITEM_TYPES: ItemTypeDef[] = [
  {
    id: "en.vocab-card",
    subject: "en",
    name: "词汇卡：中→英",
    answerMode: "text",
  },
  {
    id: "en.gap-fill",
    subject: "en",
    name: "语法填空",
    answerMode: "text",
  },
];

/**
 * 判卷用的规范化：收拾大小写、首尾空白、连续空格与**句末标点**；
 * **不纠正拼写错误，也不合并单复数**。
 *
 * 句末标点必须去掉：孩子答 `three quarters.` 与答 `three quarters` 是同一件事，
 * 因为一个句号判错只会教他"别写标点"。而 `quarter` 与 `quarters` 仍然算不一样——
 * 单复数本身就是这道题要考的东西（见下面词汇卡的注释）。
 */
export function normalizeEnglish(raw: string): string {
  const unified = raw
    .trim()
    .toLowerCase()
    // 撇号先统一：手机和 Mac 的智能标点会把 don't 打成 don’t，
    // 两个字形是同一个词，不统一就会把正确答案判错
    .replace(/[‘’´`]/g, "'")
    .replace(/\s+/g, " ");
  // 首尾要剥掉的是**句末标点与成对引号**，不包括撇号本身。
  // 早先一刀把首尾的 ' 也剥了，于是参考答案 `'s` 退化成 `s`，孩子只写一个 s 就判对。
  const trimmed = unified
    .replace(/^[\s.。!！?？,，;；]+|[\s.。!！?？,，;；]+$/g, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .replace(/^「|」$/g, "");
  return trimmed;
}

/**
 * 词汇卡判卷：完全匹配参考答案（规范化之后）。
 *
 * 为什么这一版不做"接近就算对"：词汇卡检验的是"这个词记没记住"，
 * 宽容匹配会把 `apple` 和 `apples` 判成同一回事，孩子于是永远学不会单复数。
 * 真正的口语/写作宽容度属于后面的题型，且那一类不出 `reference`。
 */
export const vocabJudge: Judge = {
  id: "en.vocab-card.judge",
  subject: "en",
  itemTypes: ["en.vocab-card"],
  judge({ reference, response }): JudgeVerdict {
    if (!reference) {
      // 没有参考答案就不是这道题——宁可交给家长，也不要凭空判一个对错
      return { correct: false, method: "pending", verification: "reference", feedback: "这道卡还没有参考答案" };
    }
    // 参考答案可以给多个可接受写法（`three quarters / three fourths`），用 `/` 分隔。
    // 双语题的答案是英文短语，只认一种写法会把"另一个正确说法"判错，而这条证据
    // 还挂着数学节点——错判会连带扣数学的掌握度。
    const accepted = (reference ?? "")
      .split("/")
      .map((s) => normalizeEnglish(s))
      .filter(Boolean);
    const ok = accepted.includes(normalizeEnglish(response));
    return {
      correct: ok,
      method: "exact",
      /**
       * `reference`：答案有出处（词表），判定可复核。
       * 刻意不是 `executable`——英语拿不出可执行验算，硬说成可执行就是骗人。
       */
      verification: "reference",
      feedback: ok ? undefined : `参考答案是 ${reference.trim()}`,
    };
  },
};

/**
 * 语法填空判卷：参考答案可能给多个可接受写法（如 `is / 's`），用 `/` 分隔。
 *
 * 这是"有标准答案"的典型形态：判定完全确定，但依据是教参而不是可执行验算，
 * 所以同样是 `reference`。
 */
export const gapFillJudge: Judge = {
  id: "en.gap-fill.judge",
  subject: "en",
  itemTypes: ["en.gap-fill"],
  judge({ reference, response }): JudgeVerdict {
    const accepted = (reference ?? "")
      .split("/")
      .map((s) => normalizeEnglish(s))
      .filter(Boolean);
    if (accepted.length === 0) {
      return { correct: false, method: "pending", verification: "reference" };
    }
    const ok = accepted.includes(normalizeEnglish(response));
    return {
      correct: ok,
      method: "accepted-set",
      verification: "reference",
      feedback: ok ? undefined : `参考答案是 ${accepted.join(" 或 ")}`,
    };
  },
};

export const JUDGES: Judge[] = [vocabJudge, gapFillJudge];
