import { Hono } from "hono";
import { z } from "zod";
import {
  compileBook,
  extractKnowledgePoints,
  listCompiledBooks,
  listCurricula,
  loadCompiledBook,
  planCurriculum,
  proposeAlignment,
  saveCompiledBook,
  saveCurriculum,
  splitChapters,
  type SavedCompiledBook,
} from "@mathtutor/knowledge";
import path from "node:path";
import type { AppState } from "./app.js";

/**
 * 教材编译：PDF 文本 → 章节 → 知识点 → 图谱候选。
 *
 * **只出提案，不写图谱**（PLAN 的硬约束）。这个接口返回的是给家长看的清单，
 * 落库那一步要等家长逐条确认，走另一个通道。
 *
 * 上游四段纯逻辑（packages/knowledge）都已经有测试；这里只负责把它们串起来、
 * 校验输入、并把"降级"如实标出来。
 */

const ProposeSchema = z.object({
  title: z.string().max(120).optional(),
  pages: z
    .array(z.object({ page: z.number().int().positive(), text: z.string() }))
    .min(1)
    .max(400),
});

export function textbookRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/propose", async (c) => {
    const parsed = ProposeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "需要 pages: [{page, text}]（页码从 1 起）" }, 400);
    }
    const { title, pages } = parsed.data;

    const chapters = splitChapters(
      pages.map((p) => ({ page: p.page, text: p.text })),
      title ?? "全书",
    );
    if (chapters.length === 0) return c.json({ error: "没有可切分的内容" }, 422);

    /*
     * 抽取不传 provider，走离线兜底：教材编译是家长触发的长动作，接模型要等抽取提示词定稿；
     * 这一版的价值是让人先看见"这本书大概能对上哪些"，而不是直接产出可上课的内容。
     *
     * 附录（答案册/索引/词汇表）不抽知识点：实测那本语法书从「Key to Exercises」往后
     * 每行都带题号，抽出来的"知识点"全是答案碎片。仍把它们列给家长看，但标出来。
     */
    const extracted = await Promise.all(
      chapters.map((chapter) =>
        chapter.backMatter
          ? Promise.resolve({ drafts: [], degraded: false })
          : extractKnowledgePoints(chapter),
      ),
    );

    // 每个知识点单独对齐：整章喂进去匹配到的是"这一章最像哪个节点"，而不是"这个知识点是哪个"
    const items = extracted.flatMap((result, i) => {
      const chapter = chapters[i]!;
      return result.drafts.map((draft) => ({
        chapterTitle: chapter.title,
        draft: { title: draft.title, evidence: draft.evidence.slice(0, 120) },
        alignment: proposeAlignment(state.knowledge.index, [
          { title: draft.title, text: draft.evidence },
        ]).items[0]!,
      }));
    });

    return c.json({
      title: title ?? null,
      chapters: chapters.map((c2) => ({
        title: c2.title,
        fromPage: c2.fromPage,
        toPage: c2.toPage,
        backMatter: c2.backMatter === true,
      })),
      items,
      // 如实标出降级：这一版全部走离线兜底，家长据此知道自己看的是低一档的候选
      degraded: extracted.some((e) => e.degraded),
      note: "仅为提案：确认后才会写入课程计划，图谱不会被直接修改",
    });
  });

  /**
   * 确认并排课：家长逐条确认后的对齐结果 → 按先修排序 → 落一份课程计划。
   *
   * 写的是 `data/knowledge/curricula/<教材名>.json`，**不碰图谱**：
   * 图谱是知识结构，课程计划是教学安排，两者寿命不同（换教材时图谱不变、计划全变）。
   */
  const ConfirmSchema = z.object({
    name: z.string().min(1).max(60),
    lessons: z
      .array(z.object({ chapterTitle: z.string().min(1), nodeId: z.string().min(1) }))
      .min(1),
  });

  app.post("/confirm", async (c) => {
    const parsed = ConfirmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 name 与 lessons: [{chapterTitle, nodeId}]" }, 400);

    // 只接受图谱里真的有的节点：确认清单来自前端，前端传错不该让计划里
    // 出现一个不存在的课
    const unknown = parsed.data.lessons.filter((l) => !state.knowledge.index.getNode(l.nodeId));
    if (unknown.length > 0) {
      return c.json({ error: `图谱里没有这些节点：${unknown.map((u) => u.nodeId).join(", ")}` }, 422);
    }

    const plan = planCurriculum(state.knowledge.index, parsed.data.lessons);
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

  app.get("/curricula", (c) => c.json({ curricula: listCurricula(state.config.dataDir) }));

  /**
   * 知识编译：章节 → 概念（跨章合并、带出处、冲突留痕）。
   *
   * 和 /propose 的区别：propose 直接出"每章对应图谱哪个节点"的候选，
   * 这里先把书编译成**书自己的概念结构**并落盘（JSON 给机器、Markdown 给家长），
   * 对齐图谱是下一步动作。书与书差异再大，也止步于编译产物这一层。
   *
   * **后台任务**，不是同步请求：一本书上百章，本地模型 45 token/s 要十几分钟，
   * 同步 HTTP 必然先被前端或反向代理掐断。POST 立刻返回 jobId，前端轮询
   * GET /compile/:jobId 看进度（第几章），编完再从 /compiled/:name 取产物。
   */
  app.post("/compile", async (c) => {
    const parsed = ProposeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "需要 pages: [{page, text}]（页码从 1 起）" }, 400);
    }
    const { title, pages } = parsed.data;

    const chapters = splitChapters(
      pages.map((p) => ({ page: p.page, text: p.text })),
      title ?? "全书",
    );
    if (chapters.length === 0) return c.json({ error: "没有可切分的内容" }, 422);

    const bookTitle = title ?? "未命名教材";
    const run = async (onChapterDone?: (done: number, total: number, chapterTitle: string) => void) => {
      const book = await compileBook(chapters, {
        title: bookTitle,
        provider: state.textbookProvider ?? null,
        concurrency: state.config.textbookCompileConcurrency,
        onChapterDone,
      });
      const saved = saveCompiledBook(state.config.dataDir, book);
      return compileSummary(book, saved);
    };

    // 没有任务存储（如某些单测装配）时退回同步执行：功能不因此消失
    if (!state.jobs) {
      return c.json(await run());
    }

    const jobs = state.jobs;
    const jobId = jobs.create(`教材编译 ${bookTitle}`);
    void run((done, total, chapterTitle) => {
      jobs.updateProgress(jobId, { stage: "compile", current: done, total, chapter: chapterTitle });
    })
      .then((result) => jobs.finish(jobId, result))
      .catch((err) => jobs.fail(jobId, String(err)));

    return c.json({ jobId, title: bookTitle, chapters: chapters.length, status: "running" }, 202);
  });

  app.get("/compile/:jobId", (c) => {
    if (!state.jobs) return c.json({ error: "任务存储未初始化" }, 503);
    const job = state.jobs.get(c.req.param("jobId"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    return c.json(job);
  });

  app.get("/compiled", (c) => c.json({ books: listCompiledBooks(state.config.dataDir) }));

  app.get("/compiled/:name", (c) => {
    const book = loadCompiledBook(state.config.dataDir, c.req.param("name"));
    if (!book) return c.json({ error: "没有这份编译产物" }, 404);
    return c.json(book);
  });

  return app;
}

/**
 * 编译产物摘要（任务结果里存的就是这个）。
 *
 * 刻意不把每个概念的原文塞进任务结果：一概念一段引文，上百个概念会把
 * 轮询响应撑到几兆；要看细节走 GET /compiled/:name。
 */
function compileSummary(
  book: Awaited<ReturnType<typeof compileBook>>,
  saved: SavedCompiledBook,
): Record<string, unknown> {
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
