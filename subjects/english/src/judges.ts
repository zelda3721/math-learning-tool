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

/** 判卷用的规范化：只收拾大小写、首尾空白与连续空格；**不纠正拼写错误** */
export function normalizeEnglish(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
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
    const ok = normalizeEnglish(response) === normalizeEnglish(reference);
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
