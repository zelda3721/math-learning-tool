import { describe, expect, it } from "vitest";
import { looksLikeHeading, splitChapters } from "../src/chapters.js";

/**
 * 章节切分：认得出来就切，认不出来就**整本一章**。
 * 碎片比不切更糟——家长要核对一长串错误章节，而错误切分会连带对齐错候选节点。
 */

describe("标题识别", () => {
  it("认得三种常见样式", () => {
    expect(looksLikeHeading("第三章 分数的意义")).toBe(true);
    expect(looksLikeHeading("第二单元")).toBe(true);
    expect(looksLikeHeading("1.2 分数的基本性质")).toBe(true);
    expect(looksLikeHeading("1、数与代数")).toBe(true);
    // 裸数字编号不算标题：实测一本练习册的题号行全被当成了章节（96 个碎片）
    expect(looksLikeHeading("1 she is")).toBe(false);
    expect(looksLikeHeading("2 I'm not hungry, but thirsty.")).toBe(false);
    expect(looksLikeHeading("一、数与代数")).toBe(true);
    // 英文教材（实测：一本真实的英语语法书，原样式把整本切成了一章）
    expect(looksLikeHeading("Unit 1 am/is/are")).toBe(true);
    expect(looksLikeHeading("Chapter 3 Fractions")).toBe(true);
    expect(looksLikeHeading("Lesson 12 I don't …")).toBe(true);
  });

  it("正文里提到「第三章」不算标题（只认行首且限定长度）", () => {
    expect(looksLikeHeading("我们在第三章学过这个")).toBe(false);
    // 以句号结尾的是句子不是标题
    expect(looksLikeHeading("第三章 分数的意义。")).toBe(false);
    // 太长的多半是正文
    expect(looksLikeHeading("1 这是一个很长的标题它其实是一整句话被错当成了标题因为它超过了长度上限")).toBe(false);
  });

  it("空行、纯空白不算标题", () => {
    expect(looksLikeHeading("")).toBe(false);
    expect(looksLikeHeading("   ")).toBe(false);
  });
});

describe("切章", () => {
  const pages = [
    { page: 1, text: "封面\n第一章 数与代数\n1.1 整数\n我们学过数数。" },
    { page: 2, text: "1.2 小数\n小数表示不足一个的东西。" },
    { page: 3, text: "第二章 图形\n三角形的内角和是 180 度。" },
  ];

  it("按标题切开，页码可回溯（家长要能翻回原书核对）", () => {
    const chapters = splitChapters(pages);
    // 首个标题之前的内容（封面）也会成一章：宁可多一章，也不丢正文
    expect(chapters.map((c) => c.title)).toEqual([
      "全书",
      "第一章 数与代数",
      "1.1 整数",
      "1.2 小数",
      "第二章 图形",
    ]);
    const first = chapters[0]!;
    expect(first.fromPage).toBe(1);
    expect(chapters[chapters.length - 1]!.toPage).toBe(3);
  });

  it("标题之前的正文归到 fallbackTitle，不丢内容", () => {
    const chapters = splitChapters(pages, "前言");
    expect(chapters[0]!.title).toBe("前言");
    expect(chapters[0]!.text).toContain("封面");
  });

  it("一个标题都没有 → 整本一章，而不是按页切成一堆碎片", () => {
    const plain = [
      { page: 1, text: "这是正文第一段。\n这是第二段。" },
      { page: 2, text: "这是第二页的正文。" },
    ];
    const chapters = splitChapters(plain);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBe("全书");
    expect(chapters[0]!.fromPage).toBe(1);
    expect(chapters[0]!.toPage).toBe(2);
  });

  it("空输入不炸", () => {
    expect(splitChapters([])).toEqual([]);
  });
});
