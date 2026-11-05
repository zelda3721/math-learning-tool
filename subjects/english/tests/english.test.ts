import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SubjectRegistry } from "@mathtutor/core";
import { englishSubject, gapFillJudge, vocabJudge } from "../src/index.js";

interface Card {
  id: string;
  zh: string;
  en: string;
  cefr: string;
  itemType?: string;
  gapSentence?: string;
  reference?: string;
}

const cards: Card[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../content/vocabulary.json", import.meta.url)), "utf8"),
);

/**
 * 阶段 1 的 DoD：不修改内核就能接入一个新学科。
 *
 * 这组测试里**没有一行**是为英语改内核的：
 * 新学科自带题型、判卷器、验证器、视觉词汇，内核只按 `SubjectPackage` 认识它。
 */
describe("英语学科包只靠注册表就能工作", () => {
  it("登记进空注册表后就能按题型取到判卷器", () => {
    const registry = new SubjectRegistry();
    registry.register(englishSubject);

    expect(registry.get("en")?.name).toBe("英语");
    expect(registry.judgeFor("en", "en.vocab-card")?.id).toBe("en.vocab-card.judge");
    expect(registry.judgeFor("en", "en.gap-fill")?.id).toBe("en.gap-fill.judge");
  });

  it("英语的判卷结果是 reference，不是 executable（拿不出可执行验算就别硬说）", () => {
    const v = vocabJudge.judge({ stem: "苹果", reference: "apple", response: "Apple " });
    expect(v).toMatchObject({ correct: true, verification: "reference" });
  });

  it("大小写与首尾空白不算错，单复数算错（词汇卡考的就是词形）", () => {
    const ok = (r: string) => vocabJudge.judge({ stem: "苹果", reference: "apple", response: r }).correct;
    expect(ok("APPLE")).toBe(true);
    expect(ok("  apple  ")).toBe(true);
    expect(ok("apples")).toBe(false);
  });

  it("没有参考答案时交给家长（pending），不凭空判对错", () => {
    const v = gapFillJudge.judge({ stem: "", reference: "", response: "goes" });
    expect(v).toMatchObject({ correct: false, method: "pending" });
  });

  it("语法填空接受多个可接受写法", () => {
    const ref = "goes / is going";
    const ok = (r: string) => gapFillJudge.judge({ stem: "", reference: ref, response: r }).correct;
    expect(ok("goes")).toBe(true);
    expect(ok("Is Going")).toBe(true);
    expect(ok("go")).toBe(false);
  });

  it("词表里每一张卡都能被对应判卷器判出结果", () => {
    for (const card of cards) {
      const judge = card.itemType === "en.gap-fill" ? gapFillJudge : vocabJudge;
      const reference = card.reference ?? card.en;
      const v = judge.judge({ stem: card.gapSentence ?? card.zh, reference, response: reference });
      expect(v.correct, `${card.id} 用自己的参考答案反而判错`).toBe(true);
      expect(v.verification).toBe("reference");
      expect(v.method).not.toBe("pending");
    }
  });
});
