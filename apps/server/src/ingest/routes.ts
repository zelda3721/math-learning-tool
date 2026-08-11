import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { EducationLevelSchema, QuestionSchema, type Question } from "@mathtutor/schema";
import { matchOffline, matchProblemTypesOffline } from "@mathtutor/knowledge";
import { checkFigure } from "./figureGate.js";
import { snapToGraph } from "./vocabulary.js";
import { boxQuality } from "./passes.js";
import { storeFigure } from "../figures.js";
import type { AppState } from "../app.js";
import { appendQuestions, contentHashOf } from "../questions.js";
import { reviewQuestion } from "../knowledgeAdmin.js";
import { offlineTextDrafts, type ExtractedDraft } from "./extraction.js";
import { processBatch, type BatchFile } from "./batch.js";

/**
 * 上传抽取管线（题源主通道）：
 * POST /upload  文本/图片/PDF → 题目草稿（含知识点/题型建议，不落库）
 * POST /confirm 人工确认终稿 → QuestionSchema 校验 + 悬挂检查 → 写批次文件
 */

const UploadSchema = z.object({
  kind: z.enum(["text", "image", "pdf"]),
  /** 文本原文，或图片/PDF 的 base64（可带 data URL 前缀） */
  content: z.string().min(1),
  batchName: z.string().optional(),
  level: EducationLevelSchema.optional(),
});

const ConfirmQuestionSchema = z.object({
  stem: z.string().min(1),
  answer: z.string().min(1),
  answerType: z.enum(["numeric", "expression", "steps"]),
  options: z.array(z.string()).optional(),
  analysis: z.string().optional(),
  difficulty: z.number().int().min(1).max(5),
  level: EducationLevelSchema,
  nodeIds: z.array(z.string()).min(1),
  problemTypeId: z.string().optional(),
  variantOf: z.string().optional(),
  // 宽松收下，入库前统一过 checkFigure（前端传回来的东西一律不可信）
  figure: z.unknown().optional(),
  /** 原题原图：前端从页图上裁下来的 data URL，入库时落盘 */
  figureImage: z.string().optional(),
});

const ConfirmSchema = z.object({
  batchName: z.string().min(1).max(64),
  questions: z.array(ConfirmQuestionSchema).min(1),
});

interface LocatedDraft extends ExtractedDraft {
  suggestedNodeIds: string[];
  suggestedProblemTypeId?: string;
  confidence: number;
  /** 模型提了但图谱里没有的说法（抽检时能看出它想选什么、我们缺什么节点） */
  droppedSuggestions?: string[];
}

/**
 * 给草稿定位知识点与题型。
 *
 * 优先用模型的提议（它读过题干，判断得了"这是计数题还是解三角形题"这种
 * 字面匹配永远分不清的事），但必须吸附到图谱里真实存在的 id——
 * 图谱里没有的知识点宁可空着，也不能凭空造一个。
 * 模型没给、或给的全都吸不上时，退回离线匹配器。
 */
function locateDraft(state: AppState, draft: ExtractedDraft): LocatedDraft {
  const snapped = snapToGraph(
    state.knowledge,
    { nodeIds: draft.proposedNodeIds, problemTypeId: draft.proposedProblemTypeId },
    draft.stem,
  );
  const nodeMatches = matchOffline(state.knowledge.index, draft.stem, 4);
  const ptMatches = matchProblemTypesOffline(state.knowledge.problemTypes, draft.stem, 1);
  const topScore = Math.max(nodeMatches[0]?.score ?? 0, ptMatches[0]?.score ?? 0);
  const fromModel = (draft.proposedNodeIds?.length ?? 0) > 0 && snapped.nodeIds.length > 0;
  return {
    ...draft,
    suggestedNodeIds: snapped.nodeIds,
    suggestedProblemTypeId: snapped.problemTypeId ?? ptMatches[0]?.id,
    // 模型点名过的题置信度不该被关键词分数拖低：那个分数量的是字面重合，
    // 而模型量的是题意。仍保留下限，让家长知道哪些是猜的。
    confidence: fromModel
      ? Math.max(0.6, Math.round(Math.min(1, topScore / 40) * 100) / 100)
      : Math.round(Math.min(1, topScore / 40) * 100) / 100,
    ...(snapped.dropped.length ? { droppedSuggestions: snapped.dropped } : {}),
  };
}

function stripDataUrl(content: string): { base64: string; mime: string | null } {
  const m = /^data:([\w/+.-]+);base64,/.exec(content);
  if (!m) return { base64: content, mime: null };
  return { base64: content.slice(m[0].length), mime: m[1]! };
}

/** PDF 文本层抽取（pdfjs-dist，动态 import 避免拖慢启动）；扫描版返回空串 */
async function extractPdfText(base64: string): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(Buffer.from(base64, "base64"));
  const task = getDocument({ data, disableFontFace: true, useSystemFonts: true });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(
        tc.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" "),
      );
    }
    return pages.join("\n").trim();
  } finally {
    await task.destroy();
  }
}

export function ingestRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/upload", async (c) => {
    const parsed = UploadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: `需要 {kind:'text'|'image'|'pdf', content}: ${parsed.error.issues[0]?.message}` }, 400);
    }
    const { kind, content, level } = parsed.data;
    const provider = state.extraction ?? null;
    const warnings: string[] = [];
    let drafts: ExtractedDraft[];

    if (kind === "text") {
      if (provider) {
        try {
          drafts = await provider.extractFromText(content, {
            level,
            onSkipped: (n) => warnings.push(`有 ${n} 道题没能读全（多半是输出被截断），已跳过`),
          });
        } catch (err) {
          warnings.push(`LLM 抽取失败（${String(err)}），已回退离线分块：答案与解析需人工填写`);
          drafts = offlineTextDrafts(content, level);
        }
      } else {
        warnings.push("未配置 LLM 抽取端点，使用离线分块兜底：答案与解析需人工填写");
        drafts = offlineTextDrafts(content, level);
      }
    } else if (kind === "image") {
      if (!provider) {
        return c.json({ error: "图片抽取需配置 LLM 端点（LLM_VISION_* 或 LLM_API_BASE）" }, 501);
      }
      const { base64, mime } = stripDataUrl(content);
      try {
        drafts = await provider.extractFromImage(base64, mime ?? "image/jpeg", {
          level,
          onSkipped: (n) =>
            warnings.push(`有 ${n} 道题没能读全（多半是输出被截断），已跳过；其余照常入草稿`),
        });
      } catch (err) {
        return c.json({ error: `图片抽取失败: ${String(err)}` }, 502);
      }
    } else {
      if (!provider) {
        return c.json({ error: "PDF 抽取需配置 LLM 端点（LLM_FAST_* 或 LLM_API_BASE）" }, 501);
      }
      const { base64 } = stripDataUrl(content);
      let pdfText: string;
      try {
        pdfText = await extractPdfText(base64);
      } catch (err) {
        return c.json({ error: `PDF 解析失败（请确认文件完整）: ${String(err)}` }, 400);
      }
      if (!pdfText) {
        return c.json({ error: "该 PDF 没有文本层（可能是扫描版），请改用拍照上传（kind:'image'）" }, 400);
      }
      try {
        drafts = await provider.extractFromText(pdfText, { level });
      } catch (err) {
        return c.json({ error: `PDF 文本抽取失败: ${String(err)}` }, 502);
      }
    }

    if (!drafts.length) warnings.push("未能从材料中抽取到题目");
    return c.json({ drafts: drafts.map((d) => locateDraft(state, d)), warnings });
  });

  // ---- 分层抽取：版面 → 逐题内容（+ 配图）。见 passes.ts 里的缘由 ----

  const LayoutSchema = z.object({ content: z.string().min(1) });

  /**
   * 第一趟：只切题。输出极短，因此几乎不会截断——
   * 而截断正是整页一次抽取最常见的死法。
   * 同时返回框的可用率：低到一定程度就该换模型，这个数得让人看得见。
   */
  app.post("/layout", async (c) => {
    const parsed = LayoutSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 {content}（页图 data URL）" }, 400);
    const provider = state.extraction;
    if (!provider?.layoutFromImage) {
      return c.json({ error: "当前抽取端点不支持分层识别" }, 501);
    }
    const { base64, mime } = stripDataUrl(parsed.data.content);
    try {
      const items = await provider.layoutFromImage(base64, mime ?? "image/jpeg");
      return c.json({ items, quality: boxQuality(items) });
    } catch (err) {
      return c.json({ error: `版面识别失败: ${String(err)}` }, 502);
    }
  });

  const QuestionSchema_ = z.object({
    /** 裁好的单题图（拿不到框时也可以是整页图） */
    content: z.string().min(1),
    level: EducationLevelSchema.optional(),
    /** 版面说这道题带图时才跑第三趟——不带图的题白跑一次配图调用是纯浪费 */
    hasFigure: z.boolean().optional(),
    /** 上一页残缺的开头，用于把跨页题拼回一道 */
    carryOver: z.string().optional(),
  });

  /**
   * 第二趟：一道题的内容。
   *
   * 这里**不再要配图规格**。原图才是配图的主表示：它就是原图，不存在
   * 重新理解的风险，而模型转写的「点线角」是二手的——已经见过它把梯形画成
   * 上下颠倒、对着数图形的网格给出 52 个点。原图由前端从页图上裁下来存盘。
   * 规格留到真要做讲解动画时再从原图转，转完还要与原图核对。
   */
  app.post("/question", async (c) => {
    const parsed = QuestionSchema_.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: `需要 {content}: ${issue?.path.join(".")} ${issue?.message}` }, 400);
    }
    const provider = state.extraction;
    if (!provider?.questionFromImage) {
      return c.json({ error: "当前抽取端点不支持分层识别" }, 501);
    }
    const { content, level, carryOver } = parsed.data;
    const { base64, mime } = stripDataUrl(content);

    let draft: ExtractedDraft | null;
    try {
      draft = await provider.questionFromImage(base64, mime ?? "image/jpeg", { level, carryOver });
    } catch (err) {
      return c.json({ error: `题目识别失败: ${String(err)}` }, 502);
    }
    if (!draft) return c.json({ draft: null, warnings: ["这一块没读出题目"] });
    return c.json({ draft: locateDraft(state, draft), warnings: [] });
  });

  app.post("/confirm", async (c) => {
    const parsed = ConfirmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: `需要 {batchName, questions[]}: ${issue?.path.join(".")} ${issue?.message}` }, 400);
    }
    const { batchName, questions } = parsed.data;
    const issues: { index: number; problem: string }[] = [];
    const accepted: Question[] = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const badNodes = q.nodeIds.filter((n) => !state.knowledge.index.nodeById.has(n));
      if (badNodes.length) {
        issues.push({ index: i, problem: `悬挂知识点 ${badNodes.join(",")}，题目未入库` });
        continue;
      }
      let problemTypeId = q.problemTypeId;
      if (problemTypeId && !state.knowledge.problemTypes.some((p) => p.id === problemTypeId)) {
        issues.push({ index: i, problem: `未知题型 ${problemTypeId}，已清除该字段` });
        problemTypeId = undefined;
      }
      // 原图落盘。存不下就只丢图不丢题——题干是好的，没必要因为一张图整题作废
      let figureImage: string | undefined;
      if (q.figureImage) {
        try {
          figureImage = storeFigure(state.config.figuresDir, q.figureImage).name;
        } catch (err) {
          issues.push({ index: i, problem: `原图未能保存（${String(err)}），题目已入库但没有配图` });
        }
      }

      const candidate = QuestionSchema.safeParse({
        id: randomUUID(),
        problemTypeId,
        figureImage,
        nodeIds: q.nodeIds,
        level: q.level,
        stem: q.stem,
        options: q.options,
        answer: q.answer,
        answerType: q.answerType,
        analysis: q.analysis,
        // 再过一次门禁：草稿是前端传回来的，中途可能被改过；
        // 图与题干对不上这件事，只在入库这一刻拦得住
        ...(() => {
          const fig = checkFigure(q.figure, q.stem);
          if (fig.rejected) issues.push({ index: i, problem: `${fig.rejected}（题目已入库，仅去掉配图）` });
          return fig.figure ? { figure: fig.figure } : {};
        })(),
        difficulty: q.difficulty,
        source: { role: "upload" as const },
        variantOf: q.variantOf,
        contentHash: contentHashOf(q.stem, q.answer),
        status: "extracted" as const,
      });
      if (!candidate.success) {
        issues.push({ index: i, problem: `schema 校验失败: ${candidate.error.issues[0]?.message}` });
        continue;
      }
      accepted.push(candidate.data);
    }

    const { written, skippedDuplicates } = appendQuestions(state.config.dataDir, batchName, accepted, state.questions);
    if (written.length) state.questions.reload();
    return c.json({ written: written.length, skippedDuplicates, issues });
  });

  // ---- P1b 批量上传（多文件 + 师生配对 + 分块，异步任务） ----
  const BatchSchema = z.object({
    batchName: z.string().min(1).max(64),
    level: EducationLevelSchema.optional(),
    files: z
      .array(
        z.object({
          name: z.string().min(1),
          kind: z.enum(["text", "pdf"]),
          /** 文本原文或 PDF base64（图片请走单发 /upload） */
          content: z.string().min(1),
          role: z.enum(["teacher", "student", "auto"]).default("auto"),
        }),
      )
      .min(1)
      .max(20),
  });

  app.post("/batch", async (c) => {
    if (!state.jobs) return c.json({ error: "批量任务存储未初始化" }, 503);
    const parsed = BatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: `需要 {batchName, files[]}: ${issue?.path.join(".")} ${issue?.message}` }, 400);
    }
    const { batchName, level, files } = parsed.data;

    // PDF 先抽文本层（同步、快）；批量的重活（LLM 抽取）进异步任务
    const batchFiles: BatchFile[] = [];
    for (const f of files) {
      if (f.kind === "text") {
        batchFiles.push({ name: f.name, text: f.content, role: f.role });
      } else {
        const { base64 } = stripDataUrl(f.content);
        let text: string;
        try {
          text = await extractPdfText(base64);
        } catch (err) {
          return c.json({ error: `${f.name}: PDF 解析失败（请确认文件完整）: ${String(err)}` }, 400);
        }
        if (!text) {
          return c.json({ error: `${f.name}: 没有文本层（可能是扫描版），请改用拍照逐页上传` }, 400);
        }
        batchFiles.push({ name: f.name, text, role: f.role });
      }
    }

    const jobId = state.jobs.create(batchName);
    const jobs = state.jobs;
    // fire-and-forget：单机单发，进程内异步执行；进度写 job 表供轮询
    void processBatch(batchFiles, state.extraction ?? null, level, (p) => jobs.updateProgress(jobId, p))
      .then((result) => {
        jobs.finish(jobId, {
          batchName,
          drafts: result.drafts.map((d) => locateDraft(state, d)),
          warnings: result.warnings,
          pairing: result.pairing,
        });
      })
      .catch((err) => jobs.fail(jobId, String(err)));
    return c.json({ jobId }, 202);
  });

  app.get("/jobs/:id", (c) => {
    if (!state.jobs) return c.json({ error: "批量任务存储未初始化" }, 503);
    const job = state.jobs.get(c.req.param("id"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    return c.json(job);
  });

  // ---- P1b 抽检（家长视角，含答案；区别于练习端的 sanitize） ----
  app.get("/questions", (c) => {
    const status = c.req.query("status");
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const items = state.questions.all
      .filter((q) => (status ? q.status === status : true))
      .slice(0, limit);
    return c.json({
      total: state.questions.all.length,
      extracted: state.questions.all.filter((q) => q.status === "extracted").length,
      items,
    });
  });

  const ReviewSchema = z.object({
    questionId: z.string().min(1),
    verdict: z.enum(["verified", "rejected"]),
    patch: z
      .object({
        stem: z.string().min(1).optional(),
        answer: z.string().min(1).optional(),
        answerType: z.enum(["numeric", "expression", "steps"]).optional(),
        difficulty: z.number().int().min(1).max(5).optional(),
        nodeIds: z.array(z.string()).min(1).optional(),
        analysis: z.string().optional(),
      })
      .optional(),
  });

  app.post("/review", async (c) => {
    const parsed = ReviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 {questionId, verdict}" }, 400);
    const { questionId, verdict, patch } = parsed.data;
    if (patch?.nodeIds) {
      const bad = patch.nodeIds.filter((n) => !state.knowledge.index.nodeById.has(n));
      if (bad.length) return c.json({ error: `悬挂知识点: ${bad.join(",")}` }, 422);
    }
    const result = reviewQuestion(state.config.dataDir, questionId, verdict, patch);
    if (!result.ok) return c.json({ error: result.error }, 404);
    state.questions.reload();
    return c.json({ ok: true, verdict, file: result.file });
  });

  return app;
}
