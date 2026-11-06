import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileBook } from "../src/compile.js";
import { listCompiledBooks, loadCompiledBook, renderConceptMarkdown, saveCompiledBook } from "../src/compiled.js";

const book = {
  title: "数学 五年级 上",
  concepts: [
    {
      id: "a1b2c3d4",
      title: "通分",
      definition: "把异分母分数化成同分母分数。",
      keyPoints: ["先找公分母"],
      prerequisites: ["最小公倍数"],
      sources: [{ chapterTitle: "第三章 分数的加减", fromPage: 41, toPage: 43, quote: "把异分母分数分别化成和原来相等的同分母分数，叫做通分。" }],
      conflicts: [],
    },
    {
      id: "e5f6a7b8",
      title: "分数单位",
      definition: "把单位一平均分成若干份，表示其中一份的数。",
      keyPoints: [],
      prerequisites: [],
      sources: [{ chapterTitle: "第一章 分数的意义", fromPage: 2, toPage: 3, quote: "表示其中一份的数，叫分数单位。" }],
      conflicts: [{ chapterTitle: "附录讲法", fromPage: 300, definition: "分子是一、分母是任意正整数的分数。" }],
    },
  ],
  links: [],
  unresolvedPrerequisites: [],
  coverage: { chapters: 2, chaptersWithConcepts: 2, concepts: 2 },
  degraded: false,
};

describe("编译产物落盘", () => {
  it("JSON 可原样读回", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "compiled-test-"));
    saveCompiledBook(dataDir, book);
    const loaded = loadCompiledBook(dataDir, "数学 五年级 上");
    expect(loaded?.concepts.map((c) => c.title)).toEqual(["通分", "分数单位"]);
    expect(loaded?.coverage.concepts).toBe(2);
  });

  it("一概念一页 Markdown + 一个索引，家长能直接读", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "compiled-test-"));
    const saved = saveCompiledBook(dataDir, book);
    expect(saved.conceptFiles).toHaveLength(2);

    const files = readdirSync(saved.markdownDir).sort();
    expect(files).toEqual(["a1b2c3d4.md", "e5f6a7b8.md", "index.md"]);

    const index = readFileSync(path.join(saved.markdownDir, "index.md"), "utf8");
    expect(index).toContain("[通分](a1b2c3d4.md)");
    expect(index).toContain("概念 2 个");
  });

  it("冲突在页面上留在原地，且写明不自动选边", () => {
    const md = renderConceptMarkdown(book.concepts[1]!);
    expect(md).toContain("## 与书中另一处说法不一致");
    expect(md).toContain("分子是一、分母是任意正整数的分数。");
    expect(md).toContain("不自动选边");
  });

  it("坏文件读回 null，不让家长页整页打不开", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "compiled-test-"));
    saveCompiledBook(dataDir, book);
    expect(loadCompiledBook(dataDir, "不存在的书")).toBeNull();
  });

  it("列表能列出编译过的书", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "compiled-test-"));
    saveCompiledBook(dataDir, book);
    expect(listCompiledBooks(dataDir)).toEqual([
      { name: "数学 五年级 上", conceptCount: 2, chapters: 2, degraded: false },
    ]);
  });

  it("同一本书重编译：id 不变，产物可对比", async () => {
    const chapter = { title: "第一章 分数", fromPage: 1, toPage: 1, text: "通分是把异分母分数化成同分母分数。" };
    const provider = {
      async extract() {
        return [
          {
            title: "通分",
            definition: "把异分母分数化成同分母分数。",
            keyPoints: [],
            prerequisites: [],
            evidence: "通分是把异分母分数化成同分母分数。",
          },
        ];
      },
    };
    const first = await compileBook([chapter], { title: "数学", provider });
    const dataDir = mkdtempSync(path.join(tmpdir(), "compiled-test-"));
    saveCompiledBook(dataDir, first);
    const second = await compileBook([chapter], { title: "数学", provider });
    expect(second.concepts[0]!.id).toBe(first.concepts[0]!.id);
    expect(loadCompiledBook(dataDir, "数学")?.concepts[0]!.id).toBe(second.concepts[0]!.id);
  });
});
