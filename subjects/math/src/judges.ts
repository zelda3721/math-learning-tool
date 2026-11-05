import type { ItemTypeDef, Judge, JudgeVerdict } from "@mathtutor/core";
import { grade } from "./grading.js";

/**
 * 数学学科包的判卷器。
 *
 * 判卷逻辑本体在 `grading.ts`（从 apps/server 平移过来，一行未改）。
 * 这里只做一层适配：把内核的 `JudgeInput` 翻译成它认识的形状，再把结果
 * 译回 `JudgeVerdict`——**适配层不许有第二个判卷真相**。
 */

export const ITEM_TYPES: ItemTypeDef[] = [
  { id: "math.numeric", subject: "math", name: "数值题", answerMode: "numeric" },
  { id: "math.expression", subject: "math", name: "表达式题", answerMode: "expression" },
  { id: "math.steps", subject: "math", name: "过程题", answerMode: "steps" },
];

export const arithmeticJudge: Judge = {
  id: "math.arithmetic.judge",
  subject: "math",
  itemTypes: ITEM_TYPES.map((t) => t.id),
  judge({ stem, reference, response, answerUnique }): JudgeVerdict {
    const result = grade(
      // answerType 只作参考：题库里的标注实测有 15 道是错的，判卷策略由答案本身推导
      { answer: reference ?? "", answerUnique, stem },
      response,
    );
    return {
      correct: result.correct,
      method: result.method,
      /**
       * `executable`：数学的判定来自可执行验算（数值等价、表达式等价、条件代入），
       * 换个人重跑一遍会得到同一个结论。
       *
       * `pending`（判不准）也标 executable：它不是"另一等级的验证"，
       * 而是"没有结论"——调用方据此转家长确认，那条路径本来就不进掌握度。
       */
      verification: "executable",
    };
  },
};

export const JUDGES: Judge[] = [arithmeticJudge];
