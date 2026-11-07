import { describe, expect, it } from "vitest";
import { REDACTED, buildPauseContext, leaksAnswer, redactAnswers } from "../src/redact.js";

/**
 * 防喂答案（宪法第 2 条）。不是"提示模型别说答案"——那种要求靠不住，
 * 模型会换个说法。这里做的是硬剔除：上下文送进去之前，答案就已经不在了。
 *
 * 这一份原本在 classroom-runtime 里。挪到内核是因为课堂提问、教材组课、
 * 将来的口语纠错都要用它，两边各写一份迟早出现"这边剔了那边没剔"。
 */

describe("剔除答案", () => {
  it("数字按整词匹配：答案是 3 时，「12 个苹果」不能被毁掉", () => {
    const r = redactAnswers("篮子里有 12 个苹果，还剩 3 个。", [{ answer: "3" }]);
    expect(r.text).toContain("12 个苹果"); // 12 里的 3 不许动
    expect(r.text).toContain(REDACTED);
    expect(r.removed).toBe(1);
  });

  it("小数不被误伤：答案是 2.5 时，「12.5」里那段不命中", () => {
    const r = redactAnswers("周长 12.5，速度 2.5", [{ answer: "2.5" }]);
    expect(r.text).toContain("12.5");
    expect(r.removed).toBe(1);
  });

  it("文字答案原样剔除，且会全段替换", () => {
    const r = redactAnswers("先算周长公式，再代进去。周长公式要先背下来。", [{ answer: "周长公式" }]);
    expect(r.text).not.toContain("周长公式");
    expect(r.removed).toBe(2);
  });

  it("单字答案不剔：抹掉会把整段话毁掉，反而让模型去猜更离谱的东西", () => {
    const r = redactAnswers("笼子里有鸡和兔，鸡有多少只？", [{ answer: "鸡" }]);
    expect(r.text).toContain("鸡和兔");
    expect(r.removed).toBe(0);
  });

  it("leaksAnswer 用来兜底：剔除函数写错了要能当场发现", () => {
    expect(leaksAnswer("还剩 3 个", [{ answer: "3" }])).toBe(true);
    expect(leaksAnswer("篮子里有 12 个", [{ answer: "3" }])).toBe(false);
  });
});

describe("暂停提问时的上下文", () => {
  const lines = ["先看有 12 个苹果", "吃掉 4 个，还剩 8 个", "所以答案是 8"];

  it("只取到当前拍为止：不把孩子还没看到的推理一起给他", () => {
    const ctx = buildPauseContext(lines, 1, [{ answer: "8" }]);
    expect(ctx).toContain("12 个苹果");
    expect(ctx).not.toContain("所以答案是"); // 第 3 句不该出现
  });

  it("答案在上下文里彻底消失（包括当前拍那句里的）", () => {
    const ctx = buildPauseContext(lines, 1, [{ answer: "8" }]);
    expect(ctx).not.toMatch(/8/);
  });

  it("越界与空输入不炸", () => {
    expect(buildPauseContext([], 3, [{ answer: "1" }])).toBe("");
    expect(buildPauseContext(lines, 99, [{ answer: "8" }])).toContain("所以答案是");
  });
});
