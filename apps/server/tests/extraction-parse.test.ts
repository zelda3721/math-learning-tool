import { describe, expect, it } from "vitest";
import { parseExtractionOutcome } from "../src/ingest/extraction.js";

const one = (stem: string, answer: string) =>
  `{"stem":"${stem}","answer":"${answer}","answerType":"numeric","difficulty":2,"level":"elementary_upper"}`;

describe("抽取输出解析：截断只该损失最后一题", () => {
  it("正常数组照常解析", () => {
    const r = parseExtractionOutcome(`[${one("甲题", "1")},${one("乙题", "2")}]`, "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["甲题", "乙题"]);
    expect(r.skipped).toBe(0);
  });

  it("在最后一个对象中间被截断时，前面的题全部保住", () => {
    // 实机报错就是这个：一页 12 道题，模型在第 92 行断掉，
    // JSON.parse 整段必然失败，于是整页颗粒无收。
    const truncated = `[${one("甲题", "1")},${one("乙题", "2")},{"stem":"丙题","answer":"3","ans`;
    const r = parseExtractionOutcome(truncated, "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["甲题", "乙题"]);
    expect(r.skipped).toBe(0); // 残缺那段压根没形成对象，不计入跳过
  });

  it("代码围栏没闭合（同样是截断的症状）也能解析", () => {
    const r = parseExtractionOutcome("```json\n[" + one("甲题", "1") + ",", "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["甲题"]);
  });

  it("中间某道题格式坏掉，只跳过它一条", () => {
    const bad = `[${one("甲题", "1")},{"stem":"乙题","answer":},${one("丙题", "3")}]`;
    const r = parseExtractionOutcome(bad, "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["甲题", "丙题"]);
    expect(r.skipped).toBe(1);
  });

  it("题干里带花括号或转义引号不会把切分弄乱", () => {
    const tricky = `[{"stem":"求 f(x)={x+1} 的值，注意\\"括号\\"","answer":"3","answerType":"numeric","difficulty":2,"level":"middle"}]`;
    const r = parseExtractionOutcome(tricky, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]!.stem).toContain("{x+1}");
  });

  it("一个 { 都没有 = 这一页没题，不是失败", () => {
    // 提示词自己写着"材料里没有题目时什么都不输出"，封面页、章节页、
    // 整页解析都会走到这里。此前一律抛错，一本讲义里几张没题的页面
    // 就成了刺眼的红色报错。
    const r = parseExtractionOutcome("材料中没有题目，不输出任何内容。", "elementary_upper");
    expect(r.drafts).toEqual([]);
    expect(r.empty).toBe(true);
  });

  it("有 { 却抠不出完整对象 = 写到一半断了，这才算失败", () => {
    expect(() => parseExtractionOutcome('{"stem":"一个长方', "elementary_upper")).toThrow(/截断/);
  });

  it("单个对象（没包数组）也认", () => {
    const r = parseExtractionOutcome(one("独题", "7"), "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["独题"]);
  });
})
