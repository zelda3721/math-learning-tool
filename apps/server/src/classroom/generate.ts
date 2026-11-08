import { z } from "zod";
import type { KnowledgeNode, Question, SceneSpec, VisualObject } from "@mathtutor/schema";
import { redactAnswers } from "@mathtutor/core";
import { validateSpec } from "@mathtutor/explainer-web";
import type { HintProvider } from "../hint.js";
import type { ComposedLesson, LessonBeatRole } from "./lesson.js";
import { revealsQuestion } from "./englishLesson.js";

/**
 * 课堂的 generate 模式：让模型把一节讲出来，但**不让它出题、也不让它给答案**。
 *
 * 三道门，缺一不可：
 *
 * 1. **题目不出自模型**。题还从题库来（`pickLessonQuestion`，already `practiceReady`），
 *    模型只看知识点档案、看不到题，也看不到答案——它连泄题的机会都没有。
 *    这正是 PLAN 那句"生成的答案必须经过验证器"的落法：这条路上根本不产生答案。
 * 2. **输出要能被机器验收**：zod 锁结构、`validateSpec` 锁画面可渲染、
 *    旁白长度与图元白名单各自有界。模型写了画不出来的东西，就当它没写。
 * 3. **任何一步不合格就退回 compose**。退回不是失败——孩子照样有一节课可上，
 *    只是这节不是模型写的。响应里写清为什么退（`degraded.reason`），
 *    否则"AI 课质量差"永远查不出是哪一环。
 */

/** 模型能用的图元：只开放**参数可核**的那几个（数量、数轴、格子、点） */
const ALLOWED_PRIMITIVES = new Set(["number_line", "quantity_bar", "unit_grid", "dot"]);

const MAX_NARRATION = 120;
const MIN_BEATS = 3;
const MAX_BEATS = 8;

const VisualSchema = z
  .object({
    id: z.string().min(1).max(24),
    // 数学四种 + 英语语法的句子高亮。英语课不画数量关系，它把例句摆出来框住要练的形式
    primitive: z.enum(["number_line", "quantity_bar", "unit_grid", "dot", "en.sentence_highlight"]),
    params: z.record(z.unknown()).default({}),
    meaning: z.string().max(60).optional(),
  })
  .strict();

const BeatSchema = z
  .object({
    role: z.enum(["intro", "concept", "example", "summary"]),
    narration: z.string().min(2).max(MAX_NARRATION),
    visual: VisualSchema.optional(),
  })
  .strict();

const GeneratedSchema = z
  .object({
    beats: z.array(BeatSchema).min(MIN_BEATS).max(MAX_BEATS),
    visualThesis: z.string().min(2).max(120),
  })
  .strict();

export type GeneratedLessonDraft = z.infer<typeof GeneratedSchema>;

export interface GenerateContext {
  /** 生成用的模型端点；没有就退回 compose */
  llm: HintProvider | null;
  /** 这道课的提问（来自题库，模型看不到它） */
  question: Question | null;
}

export interface GenerateResult {
  lesson: ComposedLesson;
  degraded: { reason: string } | null;
}

/** 这是不是一节语法单元课（与 lesson.ts 的判定同源：id 前缀 en:grammar-） */
function isGrammarNode(node: Pick<KnowledgeNode, "id">): boolean {
  return node.id.startsWith("en:grammar-");
}

/**
 * 语法课的提示词：讲的是"这个形式长什么样"，不是"这个结论怎么来的"。
 *
 * 两条比数学课更硬的限制：
 * 1. **例句只能用教材原句**——模型编一句自己觉得对的英文例句，语法可能是错的，
 *    而孩子会把它当成教材背下来。所以允许的例句集合就是档案里那几句，
 *    程序会逐字核对（见 buildLessonFromDraft）。
 * 2. **不写答案**：这节课最后要填空，模型看不到那道题。
 */
function grammarLessonPrompt(node: KnowledgeNode): string {
  return `你在给一个中国孩子讲一个英语语法点。写成 3–8 拍，每拍一句话（不超过 60 字），孩子读得懂。
知识点：${node.name}
材料（教材原文，只有这些例句可以用）：
${node.summary ?? ""}
${node.whatIsIt ? `它说的是：${node.whatIsIt}` : ""}

要求：
- 中文讲规则，英文例句逐字照抄上面的材料，**不许自己造英文句子**（造错了孩子会当成对的背下来）。
- 这节课最后会有一道填空题，但你看不到那道题：不要写"答案是…""所以填…"。
- 每拍可以配一张图，图元只有一种：en.sentence_highlight
  {"primitive":"en.sentence_highlight","params":{"text":"教材里的那句英文"}}
  句子必须与材料逐字一致；没有能对上的句子就不要图。
只输出 JSON，不要解释：
{"visualThesis":"这节课想让孩子看见什么","beats":[
 {"role":"intro|concept|example|summary","narration":"这一拍的话","visual":{"id":"s1","primitive":"en.sentence_highlight","params":{"text":"教材例句"}}}
]}`;
}

/** 模型提示词：只给档案，不给题、不给答案 */
export function lessonPrompt(node: KnowledgeNode): string {
  if (isGrammarNode(node)) return grammarLessonPrompt(node);
  const profile = [
    `知识点：${node.name}`,
    node.summary ? `一句话：${node.summary}` : "",
    node.whatIsIt ? `是什么：${node.whatIsIt}` : "",
    node.why ? `为什么学：${node.why}` : "",
    node.bigPicture ? `在主线里的位置：${node.bigPicture}` : "",
    node.applications?.[0] ? `一个用途：${node.applications[0].title}——${node.applications[0].detail}` : "",
    node.misconceptions?.[0] ? `常见误解：${node.misconceptions[0]}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `你在给一个孩子讲一个数学知识点。写成 3–8 拍，每拍一句话（不超过 60 字），孩子读得懂。
${profile}

要求：
- 只讲上面的材料里有的东西，不编造数字、不编造结论。
- 这节课最后会问一道题，但你看不到那道题：所以**不要写"答案是…""所以填…"这类句子**，
  把概念讲清楚、给一个讲透的例子就够了。
- 需要画图时只能用这四种：
  number_line {"x_range":[0,20]}；quantity_bar {"count":12}；
  unit_grid {"count":12}；dot {"x":3,"y":0}（y 恒为 0）。
  图必须和这一拍说的话对得上：说"12 个"就画 count 12，说"第 3 个"就在 x=3 放个点。
- 没有能和这句话对上的图，就不要图——有图无义比没有图更糟。

只输出 JSON，不要任何解释：
{"visualThesis":"这节课想让孩子看见什么","beats":[
 {"role":"intro|concept|example|summary","narration":"这一拍的话","visual":{"id":"v1","primitive":"quantity_bar","params":{"count":12},"meaning":"它代表什么"}}
]}`
}

/** 模型常把 JSON 包在围栏里，或者前后带一句话——都算能救的 */
export function parseLooseJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 图元参数要能被播放器真的画出来：数量类必须有正数 count，数轴必须有范围 */
function visualIssue(visual: z.infer<typeof VisualSchema>): string | null {
  if (visual.primitive === "en.sentence_highlight") {
    const text = (visual.params as { text?: unknown }).text;
    return typeof text === "string" && text.trim() ? null : "句子高亮缺少 text";
  }
  if (!ALLOWED_PRIMITIVES.has(visual.primitive)) return "图元不在白名单里";
  const count = (visual.params as { count?: unknown }).count;
  if (visual.primitive === "quantity_bar" || visual.primitive === "unit_grid") {
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0 || count > 200) {
      return "数量图元缺少合法的 count";
    }
  }
  if (visual.primitive === "number_line") {
    const range = (visual.params as { x_range?: unknown }).x_range;
    if (!Array.isArray(range) || range.length !== 2 || range.some((v) => typeof v !== "number")) {
      return "数轴缺少合法 x_range";
    }
  }
  if (visual.primitive === "dot") {
    const x = (visual.params as { x?: unknown }).x;
    if (typeof x !== "number" || !Number.isFinite(x)) return "点缺少合法 x";
  }
  return null;
}

/**
 * 把模型草稿变成一节可播的课。
 *
 * 任何一条不合格都返回 `{ ok: false, reason }`，由调用方退回 compose——
 * 不在这里"尽力修好"，因为修出来的东西没人验证过，比没有更糟。
 */
export function buildLessonFromDraft(
  node: KnowledgeNode,
  draft: unknown,
  question: Question | null,
): { ok: true; lesson: ComposedLesson } | { ok: false; reason: string } {
  const parsed = GeneratedSchema.safeParse(draft);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: `模型输出不符合结构：${first ? `${first.path.join(".")} ${first.message}` : "未知"}` };
  }
  const { beats, visualThesis } = parsed.data;
  /*
   * 语法课：模型写的旁白也不许把要填的那句先说出来（"My name is Lisa." 之于
   * "My name ___ Lisa."）。和 compose 用同一把尺子，免得两条路两道标准。
   */
  if (question && isGrammarNode(node) && beats.some((b) => revealsQuestion(b.narration, question))) {
    return { ok: false, reason: "模型把要填的那句话先讲出来了" };
  }

  const answers = question?.answer?.trim() ? [{ questionId: question.id, answer: question.answer.trim() }] : [];
  const visualObjects: VisualObject[] = [];
  const scenes: SceneSpec["scenes"] = [];
  const seenIds = new Set<string>();

  for (const [index, beat] of beats.entries()) {
    // 答案剔除是第二道防线：模型看不到题，但档案里可能写着答案，剔一遍不亏
    const narration = redactAnswers(beat.narration, answers).text.trim();
    if (!narration) return { ok: false, reason: `第 ${index + 1} 拍剔除答案后为空` };

    let action: SceneSpec["scenes"][number]["actions"] = [];
    if (beat.visual) {
      const issue = visualIssue(beat.visual);
      if (issue) return { ok: false, reason: `第 ${index + 1} 拍的图：${issue}` };
      /*
       * 语法课：例句必须逐字来自教材材料。
       * 模型造一句"看起来对"的英文，语法可能错，而孩子会当教材背下来——
       * 这条不能只靠提示词，必须由程序核对（撇号统一后再比）。
       */
      if (beat.visual.primitive === "en.sentence_highlight") {
        const text = String((beat.visual.params as { text?: unknown }).text ?? "").trim();
        const material = (node.summary ?? "").replace(/[‘’]/g, "'");
        if (!material.includes(text.replace(/[‘’]/g, "'"))) {
          return { ok: false, reason: `第 ${index + 1} 拍的例句不是教材原文` };
        }
      }
      if (seenIds.has(beat.visual.id)) return { ok: false, reason: `图元 id 重复：${beat.visual.id}` };
      seenIds.add(beat.visual.id);
      visualObjects.push({
        id: beat.visual.id,
        primitive: beat.visual.primitive,
        params: beat.visual.params,
        ...(beat.visual.meaning ? { meaning: beat.visual.meaning } : {}),
      });
      action = [{ op: "appear", target: beat.visual.id }];
    }
    scenes.push({ role: beat.role as LessonBeatRole, teaching_line: narration, actions: action });
  }

  /*
   * 提问那一拍由我们插，位置沿用 compose 的口径：讲完例子之后、小结之前。
   * 模型的拍序不完全可信（它可能把 summary 写在中间），所以这里按角色找位置，
   * 找不到就放在倒数第二拍。
   */
  const summaryAt = scenes.findIndex((s) => s.role === "summary");
  const pauseAt = summaryAt > 0 ? summaryAt : Math.max(1, scenes.length - 1);
  let pauseBeatIndex = -1;
  if (question) {
    scenes.splice(pauseAt, 0, { role: "check", teaching_line: "先停一下：这道题你会怎么讲给同桌听？", actions: [] });
    pauseBeatIndex = pauseAt;
  }

  const scene: SceneSpec = {
    visual_thesis: visualThesis,
    visual_objects: visualObjects,
    scenes,
  };

  // 播放器得真的能渲染它：未知图元、坏结构都在这里被拦下
  const validation = validateSpec(scene);
  if (validation.errors.length > 0) {
    return { ok: false, reason: `画面校验未通过：${validation.errors[0]}` };
  }

  return {
    ok: true,
    lesson: {
      nodeId: node.id,
      nodeName: node.name,
      scene,
      narrations: scenes.map((s) => s.teaching_line ?? ""),
      pauseBeatIndex,
      question: question
        ? {
            questionId: question.id,
            stem: question.stem,
            answerType: question.answerType,
            options: question.options ?? null,
            difficulty: question.difficulty,
            nodeIds: question.nodeIds,
          }
        : null,
      materialBeats: scenes.filter((s) => s.role !== "check").length,
    },
  };
}

/** 模型写一节课；调用方负责在失败时退回 compose */
export async function generateLessonDraft(node: KnowledgeNode, ctx: GenerateContext): Promise<unknown> {
  if (!ctx.llm) return null;
  const raw = await ctx.llm.generate(lessonPrompt(node));
  return parseLooseJson(raw);
}
