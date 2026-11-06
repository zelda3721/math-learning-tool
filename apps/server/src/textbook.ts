import { Hono } from "hono";
import { z } from "zod";
import {
  extractKnowledgePoints,
  listCurricula,
  planCurriculum,
  proposeAlignment,
  saveCurriculum,
  splitChapters,
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

  return app;
}
