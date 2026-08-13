/**
 * 题库管理（家长专属）。
 *
 * 此前只有抽检页，且只查 `status=extracted`——题一旦通过就在界面上永远失联，
 * 以后发现答案错了、知识点标歪了，产品里改不了，只能去翻 JSON。
 * 几百道题以后这是个会天天咬人的洞。
 *
 * 三条纪律沿用知识层既有约定：
 * ① file-first：所有修改落到 data/knowledge/questions/*.json 再 reload，
 *    绝不直接改内存——文件在 git 里，改动因此天然可审、可回滚。
 * ② 校验不放行：知识点必须存在、配图必须过门禁、schema 必须过。
 *    手改 JSON 绕得过这些检查，走这条通道绕不过。
 * ③ 批次即文件：一份材料导进来就是一个文件，所以"整批撤回"是天然可做的——
 *    导错一整份 PDF 时最需要的正是这个。
 */
import { Hono } from "hono";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EducationLevelSchema, QuestionSchema, type Question } from "@mathtutor/schema";
import { matchProblemTypesOffline } from "@mathtutor/knowledge";
import type { AppState } from "./app.js";
import { requireParentRole } from "./app.js";
import { checkFigure } from "./ingest/figureGate.js";
import { contentHashOf } from "./questions.js";
import { pruneFigures } from "./figures.js";
import { practiceReady } from "./questions.js";
import { deriveAnswerType } from "./grading.js";

const questionsDir = (dataDir: string) => path.join(dataDir, "knowledge", "questions");

/** 年级 → 学段（题型按学段组织，题目按年级标注） */
const LEVEL_STAGE: Record<Question["level"], string> = {
  elementary_lower: "primary",
  elementary_upper: "primary",
  middle: "junior",
  high: "senior",
  advanced: "university",
};

/** 批次 = 文件名（不含 .json）；一份材料导进来就是一个批次 */
function listBatches(dataDir: string): { batch: string; file: string; items: Question[] }[] {
  const dir = questionsDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({
      batch: file.replace(/\.json$/, ""),
      file,
      items: JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Question[],
    }));
}

function writeBatch(dataDir: string, file: string, items: Question[]): void {
  writeFileSync(path.join(questionsDir(dataDir), file), JSON.stringify(items, null, 2), "utf8");
}

/**
 * 删完题之后清掉没人再引用的原图。
 *
 * 不清的话 media/figures 只增不减——撤回一个批次会留下几十张孤儿，
 * 几个月后没人说得清哪张还有用，也就再没人敢动它。
 * 必须在写盘之后调用：引用集要从磁盘上的最新状态重新数。
 */
function pruneOrphanFigures(state: AppState): number {
  const referenced = new Set<string>();
  for (const b of listBatches(state.config.dataDir)) {
    for (const item of b.items) {
      if (item.figureImage) referenced.add(item.figureImage);
      if (item.analysisImage) referenced.add(item.analysisImage);
    }
  }
  return pruneFigures(state.config.figuresDir, referenced);
}

const PatchSchema = z.object({
  stem: z.string().min(1).optional(),
  answer: z.string().min(1).optional(),
  answerType: z.enum(["numeric", "expression", "steps"]).optional(),
  analysis: z.string().optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  level: EducationLevelSchema.optional(),
  nodeIds: z.array(z.string()).min(1).optional(),
  problemTypeId: z.string().nullable().optional(),
  options: z.array(z.string()).nullable().optional(),
  status: z.enum(["extracted", "verified"]).optional(),
  /** 配图：null 表示删掉配图；对象则要重新过门禁 */
  figure: z.unknown().optional(),
  /**
   * 把题干图改判为解析图。
   *
   * 分类器再准也会错（判据是版面结构，而讲义的排版千奇百怪），
   * 而错的方向恰恰是危险的那一侧：一张答案表挂成了题干图，孩子一打开就看见答案。
   * 家长抽检时看得出来，就该能一键改过来——不该为了一张图的归类
   * 去重跑十分钟推理，何况查重还会把重传的题当成重复挡掉。
   */
  moveFigureToAnalysis: z.boolean().optional(),
  /** 反过来：解析图其实是题干的一部分 */
  moveAnalysisToFigure: z.boolean().optional(),
});

export function bankRoutes(state: AppState): Hono {
  const app = new Hono();

  // 题库是家长的管理面，孩子不该看到答案
  app.use("/*", async (c, next) => {
    if (!requireParentRole(c, state)) return c.json({ error: "仅家长可用" }, 403);
    return next();
  });

  /**
   * 列表：全部题目，可按状态/学段/知识点/批次筛，题干与答案支持关键词搜索。
   * 同时给出各维度的计数（facets），让家长一眼看出「哪批导进来多少、多少还没抽检」。
   */
  app.get("/questions", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const status = c.req.query("status");
    const level = c.req.query("level");
    const nodeId = c.req.query("nodeId");
    const batch = c.req.query("batch");
    /** 只看「答案是模型自己算的、还没核对」那些——它们现在拿不到孩子手上 */
    const blockedOnly = c.req.query("blocked") === "1";
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

    const batches = listBatches(state.config.dataDir);
    const all = batches.flatMap((b) => b.items.map((item) => ({ ...item, batch: b.batch })));

    const matched = all.filter((item) => {
      if (status && item.status !== status) return false;
      if (level && item.level !== level) return false;
      if (nodeId && !item.nodeIds.includes(nodeId)) return false;
      if (batch && item.batch !== batch) return false;
      if (blockedOnly && practiceReady(item)) return false;
      if (q && !(item.stem.includes(q) || item.answer.includes(q) || item.id.includes(q))) return false;
      return true;
    });

    const count = <T extends string>(pick: (i: (typeof all)[number]) => T | undefined) => {
      const out: Record<string, number> = {};
      for (const item of all) {
        const k = pick(item);
        if (k) out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    };

    return c.json({
      total: all.length,
      matched: matched.length,
      items: matched.slice(offset, offset + limit),
      facets: {
        status: count((i) => i.status),
        level: count((i) => i.level),
        batch: count((i) => i.batch),
        withFigure: all.filter((i) => i.figureImage || i.figure).length,
        // 答案是模型自己算的、还没人核对——这些题现在不发给孩子
        blocked: all.filter((i) => !practiceReady(i)).length,
      },
    });
  });

  /** 就地修改。走同一套校验：手改 JSON 绕得过，这条通道绕不过 */
  app.patch("/questions/:id", async (c) => {
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    }
    const patch = parsed.data;
    const id = c.req.param("id");

    if (patch.nodeIds) {
      const bad = patch.nodeIds.filter((n) => !state.knowledge.index.nodeById.has(n));
      if (bad.length) return c.json({ error: `图谱里没有这些知识点：${bad.join("、")}` }, 422);
    }
    if (patch.problemTypeId) {
      const known = state.knowledge.problemTypes.some((t) => t.id === patch.problemTypeId);
      if (!known) return c.json({ error: `未知题型：${patch.problemTypeId}` }, 422);
    }

    for (const b of listBatches(state.config.dataDir)) {
      const idx = b.items.findIndex((item) => item.id === id);
      if (idx === -1) continue;
      const before = b.items[idx]!;
      const stem = patch.stem ?? before.stem;
      const answer = patch.answer ?? before.answer;

      // 配图要重新过门禁：题干改了，原来的图可能就对不上了
      let figure = before.figure;
      let figureNote: string | undefined;
      if (patch.figure !== undefined || patch.stem !== undefined) {
        const raw = patch.figure === undefined ? before.figure : patch.figure;
        if (raw === null) figure = undefined;
        else {
          const checked = checkFigure(raw, stem);
          figure = checked.figure;
          figureNote = checked.rejected;
        }
      }

      // 两张图互换归属。分类器错在哪一侧都能就地纠正
      let figureImage = before.figureImage;
      let analysisImage = before.analysisImage;
      if (patch.moveFigureToAnalysis) {
        analysisImage = figureImage;
        figureImage = undefined;
      } else if (patch.moveAnalysisToFigure) {
        figureImage = analysisImage;
        analysisImage = undefined;
      }

      const next = QuestionSchema.safeParse({
        ...before,
        ...patch,
        figureImage,
        analysisImage,
        stem,
        answer,
        problemTypeId: patch.problemTypeId === null ? undefined : (patch.problemTypeId ?? before.problemTypeId),
        options: patch.options === null ? undefined : (patch.options ?? before.options),
        figure,
        // 题干或答案变了，内容指纹要跟着变，否则查重会失效
        contentHash:
          patch.stem !== undefined || patch.answer !== undefined
            ? contentHashOf(stem, answer)
            : before.contentHash,
      });
      if (!next.success) {
        return c.json({ error: `校验失败：${next.error.issues[0]?.message}` }, 422);
      }

      b.items[idx] = next.data;
      writeBatch(state.config.dataDir, b.file, b.items);
      state.questions.reload();
      return c.json({ ok: true, question: next.data, ...(figureNote ? { figureNote } : {}) });
    }
    return c.json({ error: `题目不存在：${id}` }, 404);
  });

  /** 删除单题 */
  app.delete("/questions/:id", (c) => {
    const id = c.req.param("id");
    for (const b of listBatches(state.config.dataDir)) {
      const idx = b.items.findIndex((item) => item.id === id);
      if (idx === -1) continue;
      b.items.splice(idx, 1);
      writeBatch(state.config.dataDir, b.file, b.items);
      state.questions.reload();
      return c.json({ ok: true, removed: 1, batch: b.batch, prunedFigures: pruneOrphanFigures(state) });
    }
    return c.json({ error: `题目不存在：${id}` }, 404);
  });

  /**
   * 按答案本身重新归类 answerType。
   *
   * 模型标的类型不可信：实测 120 道里 19 道标错，其中 3 道纯数值题被标成 steps——
   * 那 3 道孩子做对了也只会看到"已交给家长确认"，掌握度不计，也进不了变式题池。
   * 入库时已按答案推导，这条是给**入库之前就存在的题**补一次。
   */
  app.post("/reclassify", (c) => {
    const changes: { id: string; from: string; to: string; answer: string }[] = [];
    for (const b of listBatches(state.config.dataDir)) {
      let touched = false;
      for (let i = 0; i < b.items.length; i += 1) {
        const item = b.items[i]!;
        const want = deriveAnswerType(item.answer);
        if (want === item.answerType) continue;
        changes.push({ id: item.id, from: item.answerType, to: want, answer: item.answer });
        b.items[i] = { ...item, answerType: want };
        touched = true;
      }
      if (touched) writeBatch(state.config.dataDir, b.file, b.items);
    }
    if (changes.length) state.questions.reload();
    return c.json({ changed: changes.length, changes });
  });

  /**
   * 给还没挂题型的题补一次题型匹配。
   *
   * 实测 157 道题只有 6 道挂上了题型——抽取时那句"拿不准就省略"写得太保守。
   * 题型不是知识点：**知识点是大纲的骨架，题型是它在具体情境下的变体**。
   * 挂上题型，讲解才拿得到"这类题的本质是什么"——「年龄问题」的本质是
   * 「年龄差永远不变」，那正是这类题唯一要讲的东西；漏了就只剩"这道题这么算"。
   *
   * 纯离线匹配（matchProblemTypesOffline，带分数下限），不调模型：
   * 已入库的题重新过一遍模型既慢又会引入新的不确定。**只补不改**——
   * 已经有题型的不动，那可能是人工核对过的。
   */
  app.post("/rematch-types", (c) => {
    const changes: { id: string; to: string; stem: string }[] = [];
    for (const b of listBatches(state.config.dataDir)) {
      let touched = false;
      for (let i = 0; i < b.items.length; i += 1) {
        const item = b.items[i]!;
        if (item.problemTypeId) continue;
        /**
         * **只在本学段的题型里找。**
         * 不筛的话「下面这幅图形中有多少个三角形？」会撞上高中的
         * 「解三角形与三角恒等」——实测 22 个匹配里有 12 个是这么来的。
         * 关键词分数分不清"题里出现了三角形"和"这是一道解三角形的题"，
         * 而学段能：小学的题不可能是高中题型。
         */
        const stage = LEVEL_STAGE[item.level];
        const candidates = state.knowledge.problemTypes.filter((t) => t.stage === stage);
        const hit = matchProblemTypesOffline(candidates, item.stem, 1)[0];
        if (!hit) continue;
        changes.push({ id: item.id, to: hit.id, stem: item.stem.slice(0, 28) });
        b.items[i] = { ...item, problemTypeId: hit.id };
        touched = true;
      }
      if (touched) writeBatch(state.config.dataDir, b.file, b.items);
    }
    if (changes.length) state.questions.reload();
    return c.json({ changed: changes.length, changes });
  });

  /**
   * 整批撤回：导错一整份材料时最需要的操作。
   * 要求把批次名再打一遍（confirm），避免手滑删掉几百道题。
   */
  app.delete("/batches/:batch", async (c) => {
    const batch = c.req.param("batch");
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== batch) {
      return c.json({ error: `请把批次名再输入一遍确认（${batch}）` }, 400);
    }
    const found = listBatches(state.config.dataDir).find((b) => b.batch === batch);
    if (!found) return c.json({ error: `批次不存在：${batch}` }, 404);
    const removed = found.items.length;
    writeBatch(state.config.dataDir, found.file, []);
    state.questions.reload();
    return c.json({ ok: true, removed, batch, prunedFigures: pruneOrphanFigures(state) });
  });

  return app;
}
