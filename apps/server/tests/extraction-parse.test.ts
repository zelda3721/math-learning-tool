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

/**
 * 可选字段写成 null。
 *
 * 这是实机上丢题最多的一处，也藏得最深：模型时而写 `"problemTypeId":""`、
 * 时而写 `"problemTypeId":null`，写 null 那次整道题被 schema 判废、静默丢掉，
 * 界面上只剩一句"这一块没读出题目"。同一张图连打两次一次成一次败，
 * 看着像模型随机，其实是这里。一份 13 道的讲义反复抽出 8~11 道，根子在此。
 */
describe("可选字段为 null 时不能丢题", () => {
  const base =
    '{"stem":"如图，小正方形ABCD放在大正方形EFGH的上面，求梯形AFGD的面积","answer":"98",' +
    '"answerType":"numeric","difficulty":3,"level":"elementary_upper"';

  it.each([
    ["problemTypeId", '"problemTypeId":null'],
    ["nodeIds", '"nodeIds":null'],
    ["options", '"options":null'],
    ["analysis", '"analysis":null'],
    ["answerFrom", '"answerFrom":null'],
    ["answerUnique", '"answerUnique":null'],
    ["answer", '"answer":null'],
    ["difficulty", '"difficulty":null'],
    ["level", '"level":null'],
  ])("%s 为 null 时题目照样收下", (_field, pair) => {
    const r = parseExtractionOutcome(`${base},${pair}}`, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    expect(r.skipped).toBe(0);
    expect(r.drafts[0]!.stem).toContain("小正方形");
  });

  it("整份都写成 null 也接得住——抽取器的职责是尽量把题接住", () => {
    const raw =
      '{"stem":"求梯形的面积","answer":null,"answerType":null,"options":null,"analysis":null,' +
      '"difficulty":null,"level":null,"nodeIds":null,"problemTypeId":null,"answerFrom":null}';
    const r = parseExtractionOutcome(raw, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    // 缺的字段走缺省，不是把题扔掉
    expect(r.drafts[0]!.answerType).toBe("numeric");
    expect(r.drafts[0]!.level).toBe("elementary_upper");
    expect(r.drafts[0]!.difficulty).toBe(2);
  });

  it("题干本身缺失才该判废——那确实不是一道题", () => {
    expect(parseExtractionOutcome('{"answer":"98"}', "elementary_upper").drafts).toHaveLength(0);
  });
});
