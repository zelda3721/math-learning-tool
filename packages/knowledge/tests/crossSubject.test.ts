import { describe, expect, it } from "vitest";
import { auditLinks, crossSubjectMembers, SUBJECT_LABEL } from "../src/crossSubject.js";
import { GraphIndex } from "../src/graph.js";
import type { Graph } from "@mathtutor/schema";
import type { KnowledgeLink } from "@mathtutor/schema";

/**
 * 跨学科连接：只显示**两边都点得开**的关系，且说明必须具体。
 *
 * 这一层最容易烂的方式不是写错字，而是慢慢长出一堆"数学和音乐有关"——
 * 看着热闹，孩子点进去什么也没得到。所以 note 长度、同学科连线、悬空端点
 * 都在 audit 里算问题。
 */

const graph = {
  stages: [{ id: "primary", name: "小学", order: 1 }],
  strands: [{ id: "number-algebra", name: "数与代数" }],
  nodes: [
    { id: "fraction", name: "分数初步认识", subject: "math", stage: "primary", strand: "number-algebra", summary: "分数", evolvesTo: [], prerequisites: [] },
    { id: "decimal", name: "小数初步认识", subject: "math", stage: "primary", strand: "number-algebra", summary: "小数", evolvesTo: [], prerequisites: [] },
    { id: "en:fraction-words", name: "分数的英文读法", subject: "english", stage: "primary", strand: "math-english", summary: "英文分数", evolvesTo: [], prerequisites: [] },
    { id: "en:money-words", name: "价格与货币表达", subject: "english", stage: "primary", strand: "math-english", summary: "美元美分", evolvesTo: [], prerequisites: [] },
  ],
} as unknown as Graph;

const index = new GraphIndex(graph);

const links: KnowledgeLink[] = [
  { from: "fraction", to: "en:fraction-words", type: "applies", note: "3/4 说 three quarters，分母用序数词" },
  { from: "decimal", to: "en:money-words", type: "applies", note: "$3.50 读作 three dollars fifty，两位小数是美分" },
  // 同学科连线：应该在 audit 里被点出来
  { from: "fraction", to: "decimal", type: "applies", note: "分数与小数可以互化，这在同一学科里说" },
];

describe("查询", () => {
  it("从数学节点能找到英语那边的连接，带上具体说明", () => {
    const members = crossSubjectMembers(index, links, "fraction");
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      nodeId: "en:fraction-words",
      nodeName: "分数的英文读法",
      subject: "english",
      type: "applies",
      direction: "out",
    });
    expect(members[0]!.note).toContain("three quarters");
  });

  it("反过来从英语节点也能找到数学这边（连接是双向的）", () => {
    const members = crossSubjectMembers(index, links, "en:fraction-words");
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ nodeId: "fraction", subject: "math", direction: "in" });
  });

  it("同学科的边不在这里显示：纵向关系看 prerequisites 就够了", () => {
    expect(crossSubjectMembers(index, links, "decimal").map((m) => m.nodeId)).not.toContain("fraction");
  });

  it("对方节点不存在时不显示（点不开的链接比没有更糟）", () => {
    const dangling: KnowledgeLink[] = [
      { from: "fraction", to: "en:not-in-graph", type: "applies", note: "这条边指向一个不存在的节点" },
    ];
    expect(crossSubjectMembers(index, dangling, "fraction")).toEqual([]);
  });

  it("节点本身不存在时给空数组，而不是抛错", () => {
    expect(crossSubjectMembers(index, links, "no-such-node")).toEqual([]);
  });
});

describe("体检", () => {
  it("点出同学科连线、悬空端点与重复边", () => {
    const messy: KnowledgeLink[] = [
      ...links,
      { from: "fraction", to: "en:fraction-words", type: "applies", note: "3/4 说 three quarters，分母用序数词" },
      { from: "fraction", to: "en:ghost", type: "applies", note: "指向不存在的节点的一条边" },
      { from: "fraction", to: "en:money-words", type: "applies", note: "太短" },
    ];
    const { problems, crossSubjectCount } = auditLinks(index, messy);
    expect(crossSubjectCount).toBe(4);
    expect(problems.some((p) => p.includes("同学科连线"))).toBe(true);
    expect(problems.some((p) => p.includes("不存在"))).toBe(true);
    expect(problems.some((p) => p.includes("重复边"))).toBe(true);
    expect(problems.some((p) => p.includes("note 太笼统"))).toBe(true);
  });

  it("干净的连接表没有抱怨", () => {
    expect(auditLinks(index, links.slice(0, 2)).problems).toEqual([]);
  });
});

describe("学科名", () => {
  it("认得数学与英语，没登记的学科原样显示", () => {
    expect(SUBJECT_LABEL.math).toBe("数学");
    expect(SUBJECT_LABEL.english).toBe("英语");
    expect(SUBJECT_LABEL.physics).toBe("物理");
    expect(SUBJECT_LABEL.chemistry ?? "chemistry").toBe("chemistry");
  });
});
