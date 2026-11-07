import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GraphSchema, LinksFileSchema } from "@mathtutor/schema";
import { SUBJECT_GRAPH_PATHS } from "../src/subjectGraphs.js";

/**
 * 英语语法主线（由教材单元结构确定性生成）。
 *
 * 锁三件事：
 * 1. **书里有多少单元就有多少节点**——漏单元是最隐蔽的错误：切章器会静默吞掉标题被版式
 *    拆散的单元（实测吞了 11 个），界面上看不出来，只表现为"学到第 8 单元突然没了"。
 * 2. **id 前缀过 lint**，且与别的学科不撞。
 * 3. **单学科不硬凑融合**：语法节点不与数学连边，连接表里也不许有指向它们的边。
 */

const grammarPath = fileURLToPath(new URL("../../../subjects/english/grammar.graph.json", import.meta.url));
const grammar = GraphSchema.parse(JSON.parse(readFileSync(grammarPath, "utf8")));

const nodes = grammar.nodes;
const byNumber = new Map(nodes.map((n) => [Number(n.id.match(/^en:grammar-(\d+)-/)?.[1]), n]));

describe("英语语法图", () => {
  it("覆盖书上 1–115 单元，一个不漏、一个不重", () => {
    const numbers = [...byNumber.keys()].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const expected = Array.from({ length: 115 }, (_, i) => i + 1);
    expect(numbers).toEqual(expected);
    expect(nodes).toHaveLength(115);
  });

  it("id 唯一、前缀是 en:（lint 认的英语前缀），且都挂在 english-grammar 这条线上", () => {
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    for (const node of nodes) {
      expect(node.id.startsWith("en:")).toBe(true);
      expect(node.subject).toBe("english");
      expect(node.strand).toBe("english-grammar");
    }
    expect(grammar.strands?.map((s) => s.id)).toContain("english-grammar");
  });

  it("每个节点都能翻回原书：带页码的出处", () => {
    for (const node of nodes) {
      expect(node.sources.length).toBeGreaterThan(0);
      expect(node.sources[0]!.title).toMatch(/Essential Grammar in Use（第 \d+ 单元，p\d+–p?\d+）/);
    }
  });

  it("单元顺序就是节点顺序（书定的顺序优先于我们编的顺序）", () => {
    const orders = nodes.map((n) => n.order ?? 0);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("单学科不硬凑融合：连接表里没有指向语法节点的边", () => {
    const links = LinksFileSchema.parse(
      JSON.parse(readFileSync(fileURLToPath(new URL("../../../data/knowledge/links.json", import.meta.url)), "utf8")),
    ).links;
    const grammarIds = new Set(nodes.map((n) => n.id));
    const touching = links.filter((l) => grammarIds.has(l.from) || grammarIds.has(l.to));
    expect(touching.map((l) => `${l.from}→${l.to}`)).toEqual([]);
  });

  it("服务器加载清单里有它（少挂一处，界面上就看不到这条主线）", () => {
    expect(SUBJECT_GRAPH_PATHS.some((file) => file.endsWith("grammar.graph.json"))).toBe(true);
  });
});
