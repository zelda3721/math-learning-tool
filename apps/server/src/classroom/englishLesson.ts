import type { KnowledgeNode, SceneSpec, VisualObject, Question } from "@mathtutor/schema";
import { practiceReady, type QuestionStore } from "../questions.js";
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

/**
 * 这句例句是不是**把这道题的答案印在了题目前面**。
 *
 * 早先的判断是 `sentence.includes(question.stem)`——永远不成立：题干带着中文指令
 * 和 `___`（"用现在进行时填空：Look! She ___ (eat)."），英文原句不可能包含它。
 * 防线因此一直是空转，真正会泄题的那一句（"My name is Lisa." 对 "My name ___ Lisa."）
 * 照样亮在提问之前。
 *
 * 现在的判法回到"这句话是不是同一句话"：把题干里的**英文部分**取出来，
 * 看它的实词有多少在例句里出现。用实词重合而不是整句相等，
 * 是因为题干往往多一个情境前缀（"Look!"）；整句比较太脆，而实词几乎全对上时，
 * 孩子照抄就能答对，和原句没区别。
 */
export function revealsQuestion(sentence: string, question: Question): boolean {
  // 题干里只留英文：中文指令、全角标点都不是这句话的一部分
  const words = question.stem
    .toLowerCase()
    .split(/[^a-z']+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  /*
   * 例句也要按撇号切开：`She's eating.` 里的 she 必须算作 she，
   * 不然最典型的那种泄题（题干 `Look! She ___ (eat).` 对例句 `She's eating.`）
   * 会因为缩写形式而判断不出来——这正是这轮修的那个漏。
   */
  const hayStem = sentence
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map((w) => (w.length >= 4 ? w.replace(/(ing|ed|es|s)$/, "") : w));
  /** 词形归一：eating / eats 都问 "eat" */
  const stem = (w: string): string => (w.length >= 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
  const hits = new Set(words.map(stem).filter((w) => hayStem.includes(w))).size;
  /*
   * 两个以上实词对得上、且占题干的大半，就认定"这是同一句话"。
   *
   * 为什么不是"全部对得上"：题干常比例句多一个情境词（`Look! She ___ (eat).`
   * 对例句 `She's eating.`），要求全部命中等于放过最典型的那种泄题——
   * 主语和动词都一样，孩子照着例句抄就能答对。
   * 为什么不是"命中一个就算"：语法课整段都在练同一个形式（be 动词、does），
   * 一个实词重合是常态，按它判会把整节课都挪到提问之后，课就没了。
   */
  return hits >= 2 && hits / words.length >= 0.6;
}

/** 这节课的提问：优先用它自己节点上"能发给孩子"的题 */
function lessonQuestionFor(store: QuestionStore, nodeId: string): Question | null {
  return pickLessonQuestion(store, nodeId);
}

/**
 * 优先挑一道**例句答不了**的题。
 *
 * 同一个节点常有好几道题（be 动词那一单元就有三道）。挑的时候先排掉"这句例句
 * 就是这道题"的那些，能挑到就用——这样例句可以留在提问之前当讲解，
 * 孩子也没法照抄。全都撞上（比如现在进行时那一单元，例句和题就是同一批句子）才退回去，
 * 由下面的分批准逻辑把撞上的例句挪到提问之后。
 */
function lessonQuestionAvoidingExamples(
  store: QuestionStore,
  nodeId: string,
  examples: string[],
): Question | null {
  const candidates = store.byNode.get(nodeId) ?? [];
  const clean = candidates.find(
    (q) => practiceReady(q) && !examples.some((sentence) => revealsQuestion(sentence, q)),
  );
  return clean ?? lessonQuestionFor(store, nodeId);
}

export function composeGrammarLesson(node: KnowledgeNode, store: QuestionStore): ComposedLesson | null {
  const examples = exampleSentences(node);
  const question = lessonQuestionAvoidingExamples(store, node.id, examples);

  const beats: { role: LessonBeatRole; narration: string; show?: string }[] = [];
  const visualObjects: VisualObject[] = [];

  // 先一句导语：这节课练什么（就是单元标题，教材作者定的）
  beats.push({ role: "intro", narration: `本单元练的是：${node.name.replace(/^Unit \d+\s*/, "")}` });

  /*
   * 例句分两批：提问**之前**只放不泄题的，会泄题的挪到提问**之后**当讲解用。
   *
   * 不能简单地把泄题的那句删掉：有些节点整段 summary 就是一句例句，
   * 删掉这节语法课就没有材料了；也不能留在前面：孩子照抄就答对，
   * 这道题测的就不再是"会不会"。挪到后面两种毛病都没有——先想，再对答案。
   */
  const before: string[] = [];
  const after: string[] = [];
  for (const sentence of examples) {
    (question && revealsQuestion(sentence, question) ? after : before).push(sentence);
  }

  const shown: string[] = [];
  const pushExample = (sentence: string, isAfterAnswer: boolean) => {
    const id = `sentence-${shown.length + 1}`;
    const highlight = highlightFor(question?.answer, sentence);
    visualObjects.push({
      id,
      primitive: "en.sentence_highlight",
      params: highlight ? { text: sentence, highlight } : { text: sentence },
      meaning: isAfterAnswer
        ? "这就是刚才那道题要填的句子"
        : highlight
          ? `例句，正在练的形式是 ${highlight}`
          : "例句",
    });
    shown.push(id);
    // 旁白就是例句本身：字幕和画面说同一句话，不额外编解说词
    beats.push({ role: "example", narration: sentence, show: id });
  };

  for (const sentence of before) pushExample(sentence, false);

  // 有题就必有一拍提问：哪怕一句不泄题的例句都没有（直接问，答完再讲）
  const pauseBeatIndex = question ? beats.length : -1;
  if (question) beats.push({ role: "check", narration: "先停一下：这道题里该填什么？" });

  // 泄题的那几句在孩子答完之后再出现，作为对答案
  for (const sentence of after) pushExample(sentence, true);

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
   * 守住"不喂答案"的是**次序**：会泄题的例句被挪到提问之后（见 revealsQuestion），
   * 提问那一拍之前只出现不泄题的句子。答案在 JSON 里仍然存在（就是那几句例句），
   * 但它们排在本拍之后、孩子答完才出现——这里是顺序，不是删除。
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
