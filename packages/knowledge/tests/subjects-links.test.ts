import { describe, expect, it } from "vitest";
import { GraphSchema, type KnowledgeLink } from "@mathtutor/schema";
import { lint } from "../src/lint.js";
import { loadKnowledge } from "../src/load.js";
import { fileURLToPath } from "node:url";

/**
 * 学科无关内核的第一批不变量（docs/PLAN.md 阶段 1）：
 * 节点要有学科归属、新学科要走命名空间、跨学科连接不能指到不存在的节点。
 *
 * 这些用合成图谱测，不拿真实数据测——真实数据今天只有数学，
 * 测不出"英语接进来会怎样"。
 */

function graph(
  nodes: Record<string, unknown>[],
  // 主线由图谱自己声明：写死成数学的四条，英语一进门就被判"主线非法"
  strands: string[] = ["number-algebra", "language"],
) {
  return GraphSchema.parse({
    stages: [],
    strands: strands.map((id) => ({ id, name: id })),
    nodes,
  });
}

const MATH_PRIMARY = {
  id: "add-sub-20",
  name: "20以内加减法",
  stage: "primary",
  strand: "number-algebra",
  summary: "会算20以内的加减",
  evolvesTo: [{ to: "algebra-core", how: "数字换成字母就是代数" }],
};
const MATH_UNI = {
  id: "algebra-core",
  name: "代数学",
  stage: "university",
  strand: "number-algebra",
  summary: "研究代数结构",
};
const EN_NODE = {
  id: "en:present-simple",
  name: "一般现在时",
  subject: "en",
  stage: "primary",
  strand: "language",
  summary: "描述习惯性动作",
};

describe("节点学科归属", () => {
  it("旧节点不写 subject 时默认为 math（75+ 个现有节点不用回填）", () => {
    const g = graph([MATH_PRIMARY, MATH_UNI]);
    expect(g.nodes.every((n) => n.subject === "math")).toBe(true);
  });

  it("非 math 学科的节点 id 必须带学科前缀，否则 lint 报错", () => {
    const bad = graph([
      MATH_PRIMARY,
      MATH_UNI,
      { ...EN_NODE, id: "present-simple" }, // 忘了加 en:
    ]);
    const report = lint(bad);
    expect(report.errors.some((e) => e.includes("学科前缀缺失"))).toBe(true);
  });

  it("带前缀的英语节点不报错，且与数学节点共存于同一张图", () => {
    const g = graph([MATH_PRIMARY, MATH_UNI, EN_NODE]);
    const report = lint(g);
    expect(report.errors).toEqual([]);
    expect(g.nodes.filter((n) => n.subject === "en")).toHaveLength(1);
    // 英语还没讲全（没有后续演化），这条对数学是硬错误，对新学科先降级为警告
    expect(report.warnings.some((w) => w.includes("孤儿") && w.includes("en 尚未讲全"))).toBe(true);
  });

  it("主线必须由图谱声明，没声明的主线仍然报错", () => {
    const g = graph([MATH_PRIMARY, MATH_UNI, EN_NODE], ["number-algebra"]);
    const report = lint(g);
    expect(report.errors.some((e) => e.includes("主线非法"))).toBe(true);
  });
});

describe("跨学科连接表", () => {
  const link = (p: Partial<KnowledgeLink>): KnowledgeLink =>
    ({ from: "add-sub-20", to: "en:present-simple", type: "analogy", note: "都有「增减」" , ...p }) as KnowledgeLink;

  it("合法的跨学科连接通过", () => {
    const g = graph([MATH_PRIMARY, MATH_UNI, EN_NODE]);
    expect(lint(g, [], [link({})]).errors).toEqual([]);
  });

  it("指向不存在的节点 → 报错（连接表最容易编造，必须能兜住）", () => {
    const g = graph([MATH_PRIMARY, MATH_UNI, EN_NODE]);
    const report = lint(g, [], [link({ to: "en:not-exist" })]);
    expect(report.errors.some((e) => e.includes("连接终点悬挂"))).toBe(true);
  });

  it("自环与重复边 → 报错", () => {
    const g = graph([MATH_PRIMARY, MATH_UNI, EN_NODE]);
    const self = lint(g, [], [link({ to: "add-sub-20" })]);
    expect(self.errors.some((e) => e.includes("连接自环"))).toBe(true);

    const dup = lint(g, [], [link({}), link({})]);
    expect(dup.errors.some((e) => e.includes("连接重复"))).toBe(true);
  });

  it("同学科的纵向关系写在连接表里 → 警告（真相只能有一个来源）", () => {
    const g = graph([MATH_PRIMARY, MATH_UNI, EN_NODE]);
    const report = lint(g, [], [
      link({ from: "add-sub-20", to: "algebra-core", type: "evolves", note: "数字换字母" }),
    ]);
    expect(report.warnings.some((w) => w.includes("同学科演化应写进节点 evolvesTo"))).toBe(true);
    expect(report.errors).toEqual([]);
  });
});

describe("真实知识层", () => {
  it("图谱 + 连接表一起过 lint，且连接表已入库", () => {
    const k = loadKnowledge({
      graphPath: fileURLToPath(new URL("../../../data/knowledge/graph.json", import.meta.url)),
      problemsPath: fileURLToPath(new URL("../../../data/knowledge/problems.json", import.meta.url)),
      linksPath: fileURLToPath(new URL("../../../data/knowledge/links.json", import.meta.url)),
      // 英语图一起加载：连接表里已经有 en: 节点了，只读数学图会把它们全判成悬挂
      subjectGraphPaths: [fileURLToPath(new URL("../../../subjects/english/graph.json", import.meta.url))],
    });
    const report = lint(k.graph, k.problemTypes, k.links);
    expect(report.errors).toEqual([]);
    // 数学与英语都在图里，跨学科连接才有落点
    expect(new Set(k.graph.nodes.map((n) => n.subject))).toEqual(new Set(["math", "english"]));
    expect(report.stats.links).toBe(k.links.length);
  });
});
