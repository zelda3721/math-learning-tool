import { describe, expect, it } from "vitest";
import { matchProblemTypesOffline, PROBLEM_TYPE_FLOOR } from "../src/locator.js";
import type { ProblemType } from "../src/graph.js";

/** 取自真实题型库的两条：一条曾是"吸铁石"，一条是正常的 */
const TYPES = [
  {
    id: "surplus-deficit",
    name: "盈亏问题",
    category: "分配",
    stage: "primary",
    example: "分苹果：每人3个多5个",
    essence: "两次分法的总差 ÷ 每份差 = 份数",
    keywords: ["盈亏", "不足", "分给", "每人", "剩"],
    nodes: [],
    methods: [],
  },
  {
    id: "magic-square",
    name: "幻方",
    category: "推理与构造",
    stage: "primary",
    example: "三阶幻方",
    essence: "每行每列每条对角线的和相等",
    keywords: ["幻方", "对角线", "每行", "每列"],
    nodes: [],
    methods: [],
  },
] as unknown as ProblemType[];

describe("题型判定：错的比没有更坏", () => {
  it("「共有多少个平行四边形」不该被判成盈亏问题", () => {
    // 这是实机踩到的：盈亏问题曾把「多」「少」列为关键词，
    // 而几乎每道中文数学题都含「多少」，于是它吸走了一切。
    const m = matchProblemTypesOffline(TYPES, "下面的图中共有多少个平行四边形？", 1);
    expect(m.map((x) => x.id)).not.toContain("surplus-deficit");
  });

  it("「邮递员有多少种走法」也不该", () => {
    const m = matchProblemTypesOffline(TYPES, "由A村去B村的道路有3条，共有多少种不同的走法？", 1);
    expect(m).toEqual([]);
  });

  it("真正的幻方题照样认得出来", () => {
    const m = matchProblemTypesOffline(TYPES, "由1到16个连续自然数构造四阶幻方，每行每列每条对角线的和是多少？", 1);
    expect(m[0]?.id).toBe("magic-square");
    expect(m[0]!.score).toBeGreaterThanOrEqual(PROBLEM_TYPE_FLOOR);
  });

  it("真正的盈亏题照样认得出来", () => {
    const m = matchProblemTypesOffline(TYPES, "把练习本平均分给同学，每人分5本还剩3本，每人分6本则不足4本", 1);
    expect(m[0]?.id).toBe("surplus-deficit");
  });

  it("单字关键词单独出现时够不到阈值", () => {
    // 「剩」是内容词、留着有用，但一个字不足以定案
    const m = matchProblemTypesOffline(TYPES, "还剩几个苹果", 1);
    expect(m).toEqual([]);
  });
});
