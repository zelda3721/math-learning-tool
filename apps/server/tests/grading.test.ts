import { describe, expect, it } from "vitest";
import { grade, parseNumeric, expressionsEquivalent } from "../src/grading.js";

describe("parseNumeric", () => {
  it("handles integers, decimals, fractions, percents, units, fullwidth", () => {
    expect(parseNumeric("26")).toBe(26);
    expect(parseNumeric("26 厘米")).toBe(26);
    expect(parseNumeric("３.５")).toBe(3.5);
    expect(parseNumeric("3/4")).toBe(0.75);
    expect(parseNumeric("75%")).toBe(0.75);
    expect(parseNumeric("-12")).toBe(-12);
    expect(parseNumeric("没有数字")).toBeNull();
    expect(parseNumeric("1/0")).toBeNull();
  });
});

describe("grade numeric", () => {
  const q = { answer: "26", answerType: "numeric" as const };
  it("accepts equivalent numeric forms", () => {
    expect(grade(q, "26").correct).toBe(true);
    expect(grade(q, "26厘米").correct).toBe(true);
    expect(grade(q, "26.0").correct).toBe(true);
  });
  it("rejects wrong values and empty", () => {
    expect(grade(q, "24").correct).toBe(false);
    expect(grade(q, "").correct).toBe(false);
  });
  it("fraction answer accepts decimal form", () => {
    const fq = { answer: "3/4", answerType: "numeric" as const };
    expect(grade(fq, "0.75").correct).toBe(true);
    expect(grade(fq, "6/8").correct).toBe(true);
  });
});

describe("grade expression", () => {
  it("accepts algebraically equivalent forms", () => {
    expect(expressionsEquivalent("2x+3", "3+2x")).toBe(true);
    expect(expressionsEquivalent("(x+1)^2", "x^2+2x+1")).toBe(true);
    expect(expressionsEquivalent("2x+3", "2x+4")).toBe(false);
  });
  it("equation answer x=4 accepts bare 4", () => {
    const q = { answer: "x=4", answerType: "expression" as const };
    expect(grade(q, "4").correct).toBe(true);
    expect(grade(q, "x=4").correct).toBe(true);
    expect(grade(q, "5").correct).toBe(false);
  });
  it("is deterministic across runs", () => {
    for (let i = 0; i < 5; i++) expect(expressionsEquivalent("x*2", "2x")).toBe(true);
  });
});

describe("grade steps", () => {
  it("marks subjective answers pending (parent review queue)", () => {
    const q = { answer: "先算周长公式", answerType: "steps" as const };
    const r = grade(q, "我先把长和宽加起来再乘二");
    expect(r.method).toBe("pending");
    expect(r.correct).toBe(false);
  });
});
