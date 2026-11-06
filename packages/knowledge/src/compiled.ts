import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CompiledBook, CompiledConcept } from "./compile.js";
import { fileSlug } from "./curricula.js";

/**
 * 编译产物的存储：`data/knowledge/compiled/<slug>.json`（机器读）+ `<slug>/<id>.md`（人读）。
 *
 * 为什么两份而不是一份：
 * - JSON 给下游（对齐、排课）用，要稳定、可 diff；
 * - Markdown 给家长用。一本 294 页的教材编译出来上百个概念，
 *   让家长在 JSON 候选列表里逐条核对是折磨；一概念一页的 wiki 才是能读的东西。
 *
 * 为什么不写进 graph.json / curricula：编译产物是**这本书的知识结构**，
 * 图谱是孩子能力结构、课程计划是教学安排，三者寿命不同，混在一起以后每次重编
 * 都会变成一次图谱改动。
 */

export const COMPILED_DIR = "compiled";

function compiledDir(dataDir: string): string {
  return path.join(dataDir, "knowledge", COMPILED_DIR);
}

export function compiledFileName(name: string): string {
  return `${fileSlug(name)}.json`;
}

/** 一概念一页 Markdown：家长能直接读、直接改，也能贴进任何 wiki 工具 */
export function renderConceptMarkdown(concept: CompiledConcept): string {
  const lines: string[] = [`# ${concept.title}`, "", `<!-- id: ${concept.id} -->`, ""];
  lines.push(concept.definition.trim() || "（书里没有给出定义）", "");

  if (concept.keyPoints.length > 0) {
    lines.push("## 要点", "");
    for (const point of concept.keyPoints) lines.push(`- ${point}`);
    lines.push("");
  }

  if (concept.prerequisites.length > 0) {
    lines.push("## 先修", "");
    for (const prereq of concept.prerequisites) lines.push(`- ${prereq}`);
    lines.push("");
  }

  lines.push("## 出处", "");
  for (const source of concept.sources) {
    lines.push(`- 《${source.chapterTitle}》 p${source.fromPage}–${source.toPage}`);
    const quote = source.quote.trim().replace(/\n+/g, " ");
    // 定位不到的引文**不当引文展示**：把模型改写的话排在 > 后面，
    // 等于把编造变成引用。这里只如实说它没能定位。
    if (!quote) continue;
    if (source.verification === "not_found") {
      lines.push("", "  （引文未能在原文定位，已不作为出处展示）", "");
    } else {
      const note = source.verification === "partial" ? "（部分句子能在原文定位）" : "";
      lines.push("", `  > ${quote}${note}`, "");
    }
  }

  if (!concept.verified) {
    lines.push("> 这个概念**没有任何一处出处能在原文里定位到**：它只是线索，不能承重。", "");
  }

  if (concept.conflicts.length > 0) {
    lines.push("## 与书中另一处说法不一致", "");
    for (const conflict of concept.conflicts) {
      lines.push(`- 《${conflict.chapterTitle}》 p${conflict.fromPage}：${conflict.definition}`);
    }
    lines.push("", "> 这里刻意不自动选边：两种说法都留着，等人来判断。", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderIndex(book: CompiledBook): string {
  const lines: string[] = [
    `# ${book.title} — 知识编译`,
    "",
    `概念 ${book.coverage.concepts} 个（${book.coverage.verifiedConcepts} 个有可定位的原文出处），覆盖 ${book.coverage.chaptersWithConcepts}/${book.coverage.chapters} 章。`,
  ];
  if (book.degraded) lines.push("", "> 本次编译有章节退回离线兜底，概念质量低一档。");
  lines.push("", "## 概念", "");
  for (const concept of book.concepts) {
    lines.push(`- [${concept.title}](${concept.id}.md) — p${concept.sources[0]?.fromPage ?? "?"}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export interface SavedCompiledBook {
  jsonPath: string;
  markdownDir: string;
  conceptFiles: string[];
}

export function saveCompiledBook(dataDir: string, book: CompiledBook): SavedCompiledBook {
  const dir = compiledDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, compiledFileName(book.title));
  writeFileSync(jsonPath, JSON.stringify(book, null, 2), "utf8");

  const markdownDir = path.join(dir, fileSlug(book.title));
  mkdirSync(markdownDir, { recursive: true });
  const conceptFiles: string[] = [];
  for (const concept of book.concepts) {
    const file = path.join(markdownDir, `${concept.id}.md`);
    writeFileSync(file, renderConceptMarkdown(concept), "utf8");
    conceptFiles.push(file);
  }
  writeFileSync(path.join(markdownDir, "index.md"), renderIndex(book), "utf8");

  return { jsonPath, markdownDir, conceptFiles };
}

/** 读一份；不存在或坏掉返回 null——坏数据不该让家长页整页打不开 */
export function loadCompiledBook(dataDir: string, name: string): CompiledBook | null {
  const file = path.join(compiledDir(dataDir), compiledFileName(name));
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CompiledBook>;
    if (!Array.isArray(parsed.concepts)) return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : name,
      concepts: parsed.concepts,
      links: Array.isArray(parsed.links) ? parsed.links : [],
      unresolvedPrerequisites: Array.isArray(parsed.unresolvedPrerequisites) ? parsed.unresolvedPrerequisites : [],
      coverage: parsed.coverage ?? {
        chapters: 0,
        chaptersWithConcepts: 0,
        concepts: parsed.concepts.length,
        verifiedConcepts: parsed.concepts.filter((c) => c.verified).length,
      },
      degraded: parsed.degraded === true,
    };
  } catch {
    return null;
  }
}

export function listCompiledBooks(
  dataDir: string,
): { name: string; conceptCount: number; chapters: number; degraded: boolean }[] {
  const dir = compiledDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: { name: string; conceptCount: number; chapters: number; degraded: boolean }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const book = loadCompiledBook(dataDir, entry.replace(/\.json$/, ""));
    if (!book) continue;
    out.push({
      name: book.title,
      conceptCount: book.concepts.length,
      chapters: book.coverage.chapters,
      degraded: book.degraded,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
