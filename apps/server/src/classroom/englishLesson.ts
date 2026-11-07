import type { KnowledgeNode, SceneSpec, VisualObject, Question } from "@mathtutor/schema";
import type { QuestionStore } from "../questions.js";
import { pickLessonQuestion, toLessonQuestion, type ComposedLesson, type LessonBeatRole } from "./lesson.js";

/**
 * 英语语法单元的组课（确定性、离线、不调用模型）。
 *
 * 与数学课的区别不只是图元：数学课讲「这个结论怎么来的」，语法课讲「这个形式长什么样」，
 * 所以拍序是 **一句一条例句** —— 例句本身就是教材给的材料，逐句亮出来、
 * 把正在练的形式框住，孩子才看得到"变化发生在哪个词上"。
 *
 * 三条硬规矩：
 * 1. **只用档案里的原句**。例句来自节点 summary（教材原文照抄），不生成、不改写。
 * 2. **找不到要框的那一段就不框**。宁可平着显示一句，也不高亮一个"差不多"的词——
 *    框错一个词，教的就是错的语法。
 * 3. **不把要考的那道题的题面先印出来**。例题可以讲，原题不能提前露。
 */

/** 一节语法课最多讲几句例句：多了就成了朗读，记不住 */
const MAX_EXAMPLE_BEATS = 4;

/** 例句：档案里的完整句子（英文句号/问号/感叹号切分） */
export function exampleSentences(node: KnowledgeNode, limit = MAX_EXAMPLE_BEATS): string[] {
  return (node.summary ?? "")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8)
    .slice(0, limit);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 这句话里真的有这个形式吗（整词、忽略大小写）。
 *
 * 撇号先统一：教材例句是弯撇号 `don’t`，参考答案常写直撇号 `don't`，
 * 不归一化就会把一个真实存在的形式判成"没有"。
 */
function containsForm(sentence: string, form: string): boolean {
  const hay = sentence.replace(/[‘’]/g, "'");
  const needle = form.replace(/[‘’]/g, "'");
  return new RegExp(`(?:^|[^a-z0-9'])${escapeRe(needle)}(?:$|[^a-z0-9'])`, "i").test(hay);
}

/**
 * 这一句该框住哪一段。
 *
 * 候选只有两种，全部来自这道题的参考答案本身：整个答法（`don't like`），
 * 或者它的最后一个词（`eating`）。**不猜近义词、不猜变形**：参考答案写 `am`
 * 而例句是 `I'm` 时，那就是没有可框的一段，这句就平着显示。
 *
 * 为什么要退到"最后一个词"：教材例句常用缩写（`She's eating.`），
 * 整段答法必然找不到；此时框住 `eating`——它在句子里**真实存在**，
 * 而且正是这一课要练的动词形式，比什么都不框更有用。
 */
export function highlightFor(answer: string | undefined, sentence: string): string | undefined {
  if (!answer) return undefined;
  const candidates = answer
    .split("/")
    .map((a) => a.trim())
    .filter(Boolean)
    .flatMap((a) => [a, a.split(/\s+/).at(-1) ?? a]);
  return candidates.find((c) => c.length > 0 && containsForm(sentence, c));
}

/** 这节课的提问：优先用它自己节点上"能发给孩子"的题 */
function lessonQuestionFor(store: QuestionStore, nodeId: string): Question | null {
  return pickLessonQuestion(store, nodeId);
}

export function composeGrammarLesson(node: KnowledgeNode, store: QuestionStore): ComposedLesson | null {
  const examples = exampleSentences(node);
  const question = lessonQuestionFor(store, node.id);

  const beats: { role: LessonBeatRole; narration: string; show?: string }[] = [];
  const visualObjects: VisualObject[] = [];

  // 先一句导语：这节课练什么（就是单元标题，教材作者定的）
  beats.push({ role: "intro", narration: `本单元练的是：${node.name.replace(/^Unit \d+\s*/, "")}` });

  const shown: string[] = [];
  for (const sentence of examples) {
    // 原题不能提前露面：例句里出现题面原句就跳过它
    if (question && sentence.replace(/\s+/g, " ").includes(question.stem.replace(/\s+/g, " "))) continue;
    const id = `sentence-${shown.length + 1}`;
    const highlight = highlightFor(question?.answer, sentence);
    visualObjects.push({
      id,
      primitive: "en.sentence_highlight",
      params: highlight ? { text: sentence, highlight } : { text: sentence },
      meaning: highlight ? `例句，正在练的形式是 ${highlight}` : "例句",
    });
    shown.push(id);
    // 旁白就是例句本身：字幕和画面说同一句话，不额外编解说词
    beats.push({ role: "example", narration: sentence, show: id });
  }

  const pauseBeatIndex = question && shown.length > 0 ? beats.length : -1;
  if (question && shown.length > 0) beats.push({ role: "check", narration: "先停一下：这道题里该填什么？" });

  if (shown.length === 0) return null;

  beats.push({ role: "summary", narration: "再读一遍这几句，注意被框住的那一段。" });

  const scene: SceneSpec = {
    visual_thesis: `${node.name}：${node.summary ?? ""}`.trim(),
    visual_objects: visualObjects,
    scenes: beats.map((beat, i) => ({
      role: beat.role,
      teaching_line: beat.narration,
      // 每一句在自己的那一拍登场：先讲的留在屏上，新的接着出现，最后一眼能看全
      actions: beat.show ? [{ op: "appear", target: beat.show }] : [],
      ...(i === 0 ? {} : {}),
    })),
  };

  /**
   * 旁白**不做答案剔除**，这一点与数学课刻意不同。
   *
   * 数学课要剔，是因为答案是一个"算出来的数"：提前说出口，这道题就没了。
   * 语法课的答案（`am`、`doesn't play`）恰恰就是要示范的形式——例句里没有它，
   * 这节课就没有内容；把它剔掉，孩子看到的是一句被挖空的病句。
   * 真正的防线换成了两条：例句不印要考的那道题的原句（上面已跳过），
   * 以及课堂提问用的是**另一个句子**（见数据：18 道语法题各自独立成句）。
   */
  const narrations = beats.map((b) => b.narration);

  return {
    nodeId: node.id,
    nodeName: node.name,
    scene,
    narrations,
    pauseBeatIndex,
    question: question ? toLessonQuestion(question) : null,
    materialBeats: beats.filter((b) => b.role !== "check").length,
  };
}
