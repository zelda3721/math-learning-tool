import { Hono } from "hono";
import { z } from "zod";
import { extractKnowledgePoints, proposeAlignment, splitChapters } from "@mathtutor/knowledge";
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
     * 抽取：不传 provider，走离线兜底。
     * 教材编译是家长触发的长动作，接模型要等抽取提示词定稿；
     * 现在这版的价值是让人先看见"这本书大概能对上哪些"，而不是直接产出可上课的内容。
     */
    const extracted = await Promise.all(
      chapters.map((chapter) => extractKnowledgePoints(chapter)),
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
      })),
      items,
      // 如实标出降级：这一版全部走离线兜底，家长据此知道自己看的是低一档的候选
      degraded: extracted.some((e) => e.degraded),
      note: "仅为提案：确认后才会写入课程计划，图谱不会被直接修改",
    });
  });

  return app;
}
