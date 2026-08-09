import { describe, expect, it } from "vitest";
import { leaksAnswer, makeHint } from "../src/hint.js";
import { makeQuestion } from "./helpers.js";

const q = makeQuestion({ id: "h1", stem: "长方形长8宽5，周长？", answer: "26" });

describe("leaksAnswer（程序端泄漏检测，LLM 说了不算）", () => {
  it("detects the bare answer value", () => {
    expect(leaksAnswer("答案就是26哦", q)).toBe(true);
    expect(leaksAnswer("(8+5)*2=26", q)).toBe(true);
  });
  it("does not false-positive on other numbers or substrings", () => {
    expect(leaksAnswer("想想长 8 和宽 5 的关系", q)).toBe(false);
    expect(leaksAnswer("先看第 126 页的例子", q)).toBe(false);
  });
});

describe("makeHint", () => {
  it("falls back to static hints without a provider and never leaks", async () => {
    for (const level of [1, 2, 3] as const) {
      const { hint, source } = await makeHint(null, q, level);
      expect(source).toBe("static");
      expect(leaksAnswer(hint, q)).toBe(false);
    }
  });

  it("censors an LLM hint that leaks the answer", async () => {
    const leaky = { generate: async () => "很简单，(8+5)×2 = 26 就是答案" };
    const { source } = await makeHint(leaky, q, 2);
    expect(source).toBe("static");
  });

  it("uses LLM hint when clean", async () => {
    const clean = { generate: async () => "先想想周长是把哪几条边加起来？" };
    const { hint, source } = await makeHint(clean, q, 2);
    expect(source).toBe("llm");
    expect(hint).toContain("周长");
  });
});
