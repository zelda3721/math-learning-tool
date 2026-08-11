import { describe, expect, it } from "vitest";
import { loadKnowledge } from "@mathtutor/knowledge";
import path from "node:path";
import { candidateNodes, snapToGraph, vocabularyPrompt } from "../src/ingest/vocabulary.js";

const REPO = path.resolve(import.meta.dirname, "../../..");
const knowledge = loadKnowledge({
  graphPath: path.join(REPO, "data/knowledge/graph.json"),
  problemsPath: path.join(REPO, "data/knowledge/problems.json"),
});

describe("候选清单：只让模型在图谱里选", () => {
  it("按材料年级收窄到本学段与相邻学段", () => {
    const primary = candidateNodes(knowledge, "elementary_upper").map((n) => n.stage);
    expect(new Set(primary)).toEqual(new Set(["primary", "junior"]));
    // 一道小学数图形的题被判成高中「解三角形」，我们已经见过；跨学段清单就是诱因
    expect(primary).not.toContain("senior");
  });

  it("清单里同时给 id 与名字，模型给哪个都能吸附", () => {
    const p = vocabularyPrompt(knowledge, "elementary_upper");
    expect(p).toContain("shape-counting(图形计数)");
    expect(p).toContain("宁可空着");
    expect(p).not.toContain("calculus-limit"); // 大学的不该出现在小学材料里
  });
});

describe("吸附：模型说什么都要落到真实 id 上", () => {
  const stem = "下面的图中共有多少个平行四边形？";

  it("给真实 id 直接采用", () => {
    const r = snapToGraph(knowledge, { nodeIds: ["shape-counting", "simple-counting"] }, stem);
    expect(r.nodeIds).toEqual(["shape-counting", "simple-counting"]);
    expect(r.dropped).toEqual([]);
  });

  it("给节点名也认得", () => {
    const r = snapToGraph(knowledge, { nodeIds: ["图形计数"] }, stem);
    expect(r.nodeIds).toEqual(["shape-counting"]);
  });

  it("给近似说法时用匹配器兜一下", () => {
    const r = snapToGraph(knowledge, { nodeIds: ["平行四边形与梯形的认识"] }, stem);
    expect(r.nodeIds[0]).toBe("parallelogram-trapezoid");
  });

  it("图谱里没有的说法一律丢弃并记下来——不能凭空造节点", () => {
    // 星图会长出不存在的节点、掌握度也就无从统计，所以宁可空着
    const r = snapToGraph(knowledge, { nodeIds: ["高等魔法学"] }, "小明有 5 个苹果");
    expect(r.nodeIds).not.toContain("高等魔法学");
    expect(r.dropped).toContain("高等魔法学");
  });

  it("一个都吸不上时退回离线匹配器", () => {
    const r = snapToGraph(knowledge, { nodeIds: ["不存在的东西"] },
      "一个长方形的长是 8 厘米，宽是 5 厘米，求它的周长");
    expect(r.nodeIds.length).toBeGreaterThan(0);
    expect(r.dropped).toContain("不存在的东西");
  });

  it("匹配器也够不着时就空着——这正是要让模型点名的原因", () => {
    // 「计算 3/4 + 1/2」题干里没有"通分""分数加减"这类词，字面匹配注定为空。
    // 返回空数组是对的：错的知识点比没有知识点更坏。
    const bare = snapToGraph(knowledge, {}, "计算 3/4 + 1/2 的和");
    expect(bare.nodeIds).toEqual([]);
    // 而模型读得懂它考什么，点名即可
    const named = snapToGraph(knowledge, { nodeIds: ["fraction-arithmetic"] }, "计算 3/4 + 1/2 的和");
    expect(named.nodeIds).toEqual(["fraction-arithmetic"]);
  });

  it("模型没给提议时同样退回匹配器", () => {
    const r = snapToGraph(knowledge, {}, "一个长方形长 8 厘米宽 5 厘米，求周长");
    expect(r.nodeIds.length).toBeGreaterThan(0);
  });

  it("题型同样只认真实的，最多留 4 个知识点", () => {
    const ok = snapToGraph(knowledge, { nodeIds: [], problemTypeId: "chickens-rabbits" }, stem);
    expect(ok.problemTypeId).toBe("chickens-rabbits");
    const bad = snapToGraph(knowledge, { nodeIds: [], problemTypeId: "编出来的题型" }, stem);
    expect(bad.problemTypeId).toBeUndefined();
    expect(bad.dropped).toContain("编出来的题型");
    const many = snapToGraph(knowledge, {
      nodeIds: ["shape-counting", "simple-counting", "triangle-primary", "perimeter", "area-units"],
    }, stem);
    expect(many.nodeIds.length).toBeLessThanOrEqual(4);
  });

  it("去重：模型重复给同一个知识点不该出现两次", () => {
    const r = snapToGraph(knowledge, { nodeIds: ["图形计数", "shape-counting"] }, stem);
    expect(r.nodeIds).toEqual(["shape-counting"]);
  });

  it("能解决关键词永远够不着的那类题", () => {
    // 「共有多少种不同的走法」题干里没有"计数原理"四个字，字面匹配永远匹配不到；
    // 模型读得懂题意，点名即可
    const r = snapToGraph(knowledge, { nodeIds: ["counting-principle"] },
      "由A村去B村的道路有3条，由B村去C村有2条，共有多少种不同的走法？");
    expect(r.nodeIds).toContain("counting-principle");
  });
})
