import { Hono } from "hono";
import { z } from "zod";
import {
  compileBook,
  listCompiledBooks,
  listCurricula,
  loadCompiledBook,
  planCurriculum,
  proposeAlignment,
  saveCompiledBook,
  saveCurriculum,
  splitChapters,
  type CompiledBook,
  type ConceptExtractionProvider,
  type SavedCompiledBook,
} from "@mathtutor/knowledge";
import path from "node:path";
import { extractPdfPages, nonEmptyPages } from "./ingest/pdf.js";
import type { AppState } from "./app.js";

/**
 * 教材编译的一条链：PDF → 章节 → 概念（编译产物）→ 图谱候选 → 家长确认 → 课程计划。
 *
 * 只有**一条**主路径。之前 /propose（逐章抽点）与 /compile（概念编译）并存，
 * 而 /confirm 只认章节标题、认不出概念 id——结果是编译产物根本接不到排课上。
 * 同一件事两种实现，最后两边都不完整。
 *
 * 硬约束仍然成立：候选**绝不直接写图谱**（PLAN 第二部分）。
 * 这里所有接口的产物要么是文件（compiled/、curricula/），要么是待确认清单。
 */

const CompileSchema = z
  .object({
    title: z.string().max(120).optional(),
    /** 前端已经切好页（单测与"从别处来的页文本"用这条） */
    pages: z
      .array(z.object({ page: z.number().int().positive(), text: z.string() }))
      .min(1)
      .max(600)
      .optional(),
    /** 直接传 PDF（家长上传的真实路径）：base64，可带 data URL 前缀 */
    pdfBase64: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.pages) || Boolean(v.pdfBase64), { message: "需要 pages 或 pdfBase64" });

/** 去掉 data URL 前缀，只留 base64 本体 */
function stripDataUrl(content: string): string {
  const m = /^data:([\w/+.-]+);base64,/.exec(content);
  return m ? content.slice(m[0].length) : content;
}

/**
 * 全局并发闸。
 *
 * 每本书内部的并发是 compileBook 的事，但两本书同时编译就会把请求数翻倍——
 * 而本地模型只有 45 token/s，翻倍不会更快，只会让每个请求都变慢、更容易撞超时。
 * 闸放在进程级：不论开几个任务，同时在飞的模型请求数就是配置的那一个数。
 */
function createGate(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  };
}

export function textbookRoutes(state: AppState): Hono {
  const app = new Hono();
  const gate = createGate(Math.max(1, state.config.textbookCompileConcurrency));

  /** 编译一份书：切章 → 编译概念 → 落盘 → 摘要 */
  const runCompile = async (
    title: string | undefined,
    pages: { page: number; text: string }[],
    onChapterDone?: (done: number, total: number, chapterTitle: string) => void,
  ) => {
    const chapters = splitChapters(pages, title ?? "全书");
    if (chapters.length === 0) return null;

    const provider = state.textbookProvider ?? null;
    // 闸套在 provider 上：并发上限是进程级的，不是每本书各算一份
    const gatedProvider: ConceptExtractionProvider | null = provider
      ? { extract: (input) => gate(() => provider.extract(input)) }
      : null;

    const book = await compileBook(chapters, {
      title: title ?? "未命名教材",
      provider: gatedProvider,
      concurrency: state.config.textbookCompileConcurrency,
      onChapterDone,
    });
    const saved = saveCompiledBook(state.config.dataDir, book);
    return compileSummary(book, saved);
  };

  /**
   * 知识编译：PDF（或页文本）→ 概念，落 data/knowledge/compiled/，**不碰图谱**。
   *
   * 后台任务，不是同步请求：一本书上百章，本地模型 45 token/s 要十几分钟，
   * 同步 HTTP 必然先被前端或反向代理掐断。POST 立刻返回 jobId，
   * 前端轮询 GET /compile/:jobId 看进度（第几章），编完再从 /compiled/:name 取产物。
   */
  app.post("/compile", async (c) => {
    const parsed = CompileSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "需要 pages: [{page, text}] 或 pdfBase64" }, 400);
    }
    const { title, pages, pdfBase64 } = parsed.data;

    let pageTexts = pages ?? [];
    if (pdfBase64) {
      let extracted: { page: number; text: string }[];
      try {
        extracted = await extractPdfPages(stripDataUrl(pdfBase64));
      } catch (err) {
        return c.json({ error: `PDF 解析失败（请确认文件完整）: ${String(err)}` }, 400);
      }
      pageTexts = nonEmptyPages(extracted);
      if (pageTexts.length === 0) {
        return c.json({ error: "这份 PDF 没有文本层（可能是扫描版），请先做 OCR 或改用页文本" }, 422);
      }
    }

    const bookTitle = title ?? (pdfBase64 ? "未命名教材" : "全书");
    const chapterCount = splitChapters(pageTexts, bookTitle).length;
    if (chapterCount === 0) return c.json({ error: "没有可切分的内容" }, 422);

    // 没有任务存储（如某些单测装配）时退回同步执行：功能不因此消失
    if (!state.jobs) {
      const result = await runCompile(bookTitle, pageTexts);
      if (!result) return c.json({ error: "没有可切分的内容" }, 422);
      return c.json(result);
    }

    const jobs = state.jobs;
    const jobId = jobs.create(`教材编译 ${bookTitle}`);
    void runCompile(bookTitle, pageTexts, (done, total, chapterTitle) => {
      jobs.updateProgress(jobId, { stage: "compile", current: done, total, chapter: chapterTitle });
    })
      .then((result) => jobs.finish(jobId, result))
      .catch((err) => jobs.fail(jobId, String(err)));

    return c.json({ jobId, title: bookTitle, chapters: chapterCount, status: "running" }, 202);
  });

  app.get("/compile/:jobId", (c) => {
    if (!state.jobs) return c.json({ error: "任务存储未初始化" }, 503);
    const job = state.jobs.get(c.req.param("jobId"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    return c.json(job);
  });

  /**
   * 从编译产物出图谱候选。
   *
   * 只有**有可定位原文出处**的概念才参与：出处定位不到的概念只是线索
   * （教学宪法第 5 条：未经验证的知识不承重），让它进候选等于让模型的自述去改图谱。
   */
  app.post("/align", async (c) => {
    const parsed = z.object({ name: z.string().min(1).max(60) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 name（编译产物名）" }, 400);

    const book = loadCompiledBook(state.config.dataDir, parsed.data.name);
    if (!book) return c.json({ error: "没有这份编译产物，先调用 /compile" }, 404);

    const verified = book.concepts.filter((concept) => concept.verified);
    // 一个概念一次匹配：整章喂进去匹配到的是"这一章最像哪个节点"，不是"这个概念是哪个"
    const items = verified.map((concept) => {
      const title = concept.title;
      const text = [
        concept.definition,
        ...concept.keyPoints,
        ...concept.sources.filter((s) => s.verification !== "not_found").map((s) => s.quote),
      ].join("\n");
      const alignment = proposeAlignment(state.knowledge.index, [{ title, text }]).items[0]!;
      return {
        conceptId: concept.id,
        conceptTitle: title,
        candidates: alignment.candidates,
        status: alignment.status,
      };
    });

    return c.json({
      name: book.title,
      items,
      pendingCount: items.length,
      skippedUnverified: book.concepts.length - verified.length,
      note: "仅为候选：确认后才会写入课程计划，图谱不会被直接修改",
    });
  });

  /**
   * 确认并排课：家长逐条确认的（概念 → 节点）→ 按先修排序 → 落一份课程计划。
   *
   * 写的是 `data/knowledge/curricula/<教材名>.json`，**不碰图谱**：
   * 图谱是知识结构，课程计划是教学安排，两者寿命不同（换教材时图谱不变、计划全变）。
   */
  const ConfirmSchema = z.object({
    name: z.string().min(1).max(60),
    lessons: z.array(z.object({ conceptId: z.string().min(1), nodeId: z.string().min(1) })).min(1),
  });

  app.post("/confirm", async (c) => {
    const parsed = ConfirmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 name 与 lessons: [{conceptId, nodeId}]" }, 400);

    const book = loadCompiledBook(state.config.dataDir, parsed.data.name);
    if (!book) return c.json({ error: "没有这份编译产物，先调用 /compile" }, 404);

    // 只接受图谱里真的有的节点：确认清单来自前端，前端传错不该让计划里出现一节不存在的课
    const unknownNodes = parsed.data.lessons.filter((l) => !state.knowledge.index.getNode(l.nodeId));
    if (unknownNodes.length > 0) {
      return c.json({ error: `图谱里没有这些节点：${unknownNodes.map((u) => u.nodeId).join(", ")}` }, 422);
    }

    // 只接受编译产物里真的有的概念：排出来的课要能回指到"书里的哪一条"
    const conceptById = new Map(book.concepts.map((concept) => [concept.id, concept]));
    const unknownConcepts = parsed.data.lessons.filter((l) => !conceptById.has(l.conceptId));
    if (unknownConcepts.length > 0) {
      return c.json({ error: `这份编译产物里没有这些概念：${unknownConcepts.map((u) => u.conceptId).join(", ")}` }, 422);
    }

    const links = parsed.data.lessons.map((l) => ({
      chapterTitle: conceptById.get(l.conceptId)!.title,
      nodeId: l.nodeId,
      conceptId: l.conceptId,
    }));
    const plan = planCurriculum(state.knowledge.index, links);
    const file = saveCurriculum(state.config.dataDir, {
      name: parsed.data.name,
      lessons: plan.lessons,
      createdAt: new Date().toISOString(),
    });

    return c.json({
      name: parsed.data.name,
      lessons: plan.lessons,
      // 有环时退回原书顺序：要如实说，否则家长会以为排课成功了
      cycleDetected: plan.cycleDetected,
      savedTo: path.basename(file),
    });
  });

  app.get("/compiled", (c) => c.json({ books: listCompiledBooks(state.config.dataDir) }));

  app.get("/compiled/:name", (c) => {
    const book = loadCompiledBook(state.config.dataDir, c.req.param("name"));
    if (!book) return c.json({ error: "没有这份编译产物" }, 404);
    return c.json(book);
  });

  app.get("/curricula", (c) => c.json({ curricula: listCurricula(state.config.dataDir) }));

  return app;
}

/**
 * 编译产物摘要（任务结果里存的就是这个）。
 *
 * 刻意不把每个概念的原文塞进任务结果：一概念一段引文，上百个概念会把
 * 轮询响应撑到几兆；要看细节走 GET /compiled/:name。
 */
function compileSummary(book: CompiledBook, saved: SavedCompiledBook): Record<string, unknown> {
  return {
    title: book.title,
    concepts: book.concepts.map((concept) => ({
      id: concept.id,
      title: concept.title,
      definition: concept.definition,
      keyPointCount: concept.keyPoints.length,
      prerequisites: concept.prerequisites,
      sourceCount: concept.sources.length,
      /** 有可定位原文出处的出处条数：0 表示这个概念只是线索 */
      verifiedSourceCount: concept.sources.filter((s) => s.verification !== "not_found").length,
      verified: concept.verified,
      conflictCount: concept.conflicts.length,
    })),
    links: book.links,
    unresolvedPrerequisites: book.unresolvedPrerequisites,
    coverage: book.coverage,
    degraded: book.degraded,
    savedTo: path.basename(saved.jsonPath),
    markdownDir: path.basename(saved.markdownDir),
    note: "编译产物：只写 data/knowledge/compiled/，图谱不会被修改",
  };
}
