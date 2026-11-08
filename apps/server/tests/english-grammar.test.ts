import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GraphSchema, LinksFileSchema, QuestionSchema, type Question } from "@mathtutor/schema";
import { SUBJECT_GRAPH_PATHS } from "../src/subjectGraphs.js";
import { createSubjectRegistry, itemTypeOf, judgeAnswer, subjectOf } from "../src/subjects.js";
import { bilingualIssues, loadQuestionFiles } from "../src/questions.js";
import { knowledge } from "./helpers.js";

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

const bankPath = fileURLToPath(
  new URL("../../../data/knowledge/questions/2026-11-06-english-grammar.json", import.meta.url),
);
const bank: Question[] = (JSON.parse(readFileSync(bankPath, "utf8")) as unknown[]).map((raw) =>
  QuestionSchema.parse(raw),
);

describe("英语语法题能判、也能进库", () => {
  const registry = createSubjectRegistry();

  it("题挂在语法节点上，按学科归属解析成英语，题型是语法填空", () => {
    for (const q of bank) {
      expect(subjectOf(q, knowledge), q.id).toBe("en");
      expect(itemTypeOf("en", q), q.id).toBe("en.gap-fill");
    }
  });

  it("单学科英语题不被双语规矩拦（全是英语节点，不需要再挂英文题面）", () => {
    for (const q of bank) expect(bilingualIssues(q, knowledge.index), q.id).toEqual([]);
  });

  it("题库加载零问题：没有悬挂知识点、没有重复", () => {
    const { questions, issues } = loadQuestionFiles(
      fileURLToPath(new URL("../../../data/knowledge/questions", import.meta.url)),
      knowledge.index,
    );
    expect(issues).toEqual([]);
    expect(questions.length).toBeGreaterThanOrEqual(bank.length);
  });

  it("判卷走 en.gap-fill：大小写与句末标点不影响，写错就是错", async () => {
    const q = bank.find((x) => x.id === "en-grammar-01")!;
    const right = await judgeAnswer(registry, knowledge, q, "AM ");
    expect(right).toMatchObject({ correct: true, method: "accepted-set", verification: "reference" });
    const wrong = await judgeAnswer(registry, knowledge, q, "is");
    expect(wrong.correct).toBe(false);
    expect(wrong.feedback).toContain("am");
  });

  it("参考答案写了几种写法，就认几种（don't like / do not like）", async () => {
    const q = bank.find((x) => x.stem.includes("coffee"))!;
    for (const answer of ["don't like", "Do not like.", "DON'T LIKE"]) {
      const verdict = await judgeAnswer(registry, knowledge, q, answer);
      expect(verdict.correct, answer).toBe(true);
    }
    expect((await judgeAnswer(registry, knowledge, q, "not like")).correct).toBe(false);
  });
});

describe("判卷的两个真错判（审查抓到的）", () => {
  const registry = createSubjectRegistry();
  const bank = loadQuestionFiles(
    fileURLToPath(new URL("../../../data/knowledge/questions", import.meta.url)),
    knowledge.index,
  ).questions.filter((q) => q.id.startsWith("en-") || q.id.startsWith("bi-"));
  it("智能标点打的 don’t 不该被判错", async () => {
    const q = bank.find((x) => x.stem.includes("coffee"))!;
    const verdict = await judgeAnswer(registry, knowledge, q, "don’t like");
    expect(verdict.correct).toBe(true);
  });

  it("只写一个 s 不能算对 's（首尾撇号不再被剥掉）", async () => {
    const { gapFillJudge } = await import("@mathtutor/subject-english");
    expect(gapFillJudge.judge({ reference: "is / 's", response: "s", itemType: "en.gap-fill" }).correct).toBe(false);
    expect(gapFillJudge.judge({ reference: "is / 's", response: "'s", itemType: "en.gap-fill" }).correct).toBe(true);
  });

  it("问句第一词是 Are，填 is 就是错（题库里参考答案曾写成 Are / is）", async () => {
    const q = bank.find((x) => x.id === "en-grammar-04")!;
    expect(q.answer).toBe("Are");
    expect((await judgeAnswer(registry, knowledge, q, "is")).correct).toBe(false);
    expect((await judgeAnswer(registry, knowledge, q, "ARE")).correct).toBe(true);
  });

  it("双语题用英文作答时，另一种正确说法也认（three fourths）", async () => {
    const q = bank.find((x) => x.id === "bi-fraction-words-01")!;
    expect((await judgeAnswer(registry, knowledge, q, "three fourths")).correct).toBe(true);
    expect((await judgeAnswer(registry, knowledge, q, "three quarters")).correct).toBe(true);
    expect((await judgeAnswer(registry, knowledge, q, "three")).correct).toBe(false);
  });
});
