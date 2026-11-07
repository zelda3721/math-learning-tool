import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { QuestionSchema, type Question } from "@mathtutor/schema";
import { composeLesson, availableLessons } from "../src/classroom/lesson.js";
import { exampleSentences, highlightFor } from "../src/classroom/englishLesson.js";
import { validateSpec } from "@mathtutor/explainer-web";
import { knowledge, tempFixtureEnv } from "./helpers.js";

/**
 * 语法单元的课：一句一条例句，把正在练的形式框住。
 *
 * 锁住的几件事都是"错的课比没有课更糟"的具体形态：
 * - 例句必须是教材原句（不生成、不改写）；
 * - 要考的题不能提前印在例句里；
 * - 框错词就教错语法，所以找不到形式时宁可不开框；
 * - 场景要过播放器校验（有一个未知图元就等于这一课画不出来）。
 */

const GRAMMAR_NODE = "en:grammar-3-i-am-doing-present-continuous";
const VOCAB_NODE = "en:money-words";

/** 用真实的语法题库（临时目录，读写都不碰 data/） */
const grammarQuestions: Question[] = (
  JSON.parse(
    readFileSync(new URL("../../../data/knowledge/questions/2026-11-06-english-grammar.json", import.meta.url), "utf8"),
  ) as unknown[]
).map((raw) => QuestionSchema.parse(raw));

describe("语法课组课", () => {
  const { store } = tempFixtureEnv(grammarQuestions);
  const lesson = composeLesson(GRAMMAR_NODE, knowledge.index, store);

  it("能组出课来，且每一拍都有旁白", () => {
    expect(lesson).toBeTruthy();
    expect(lesson!.scene.scenes.length).toBeGreaterThan(1);
    expect(lesson!.narrations).toHaveLength(lesson!.scene.scenes.length);
    for (const n of lesson!.narrations) expect(n.trim().length).toBeGreaterThan(0);
  });

  it("例句用教材原句，逐拍登场（第 1 句在第 1 个例句拍出现）", () => {
    const sentences = exampleSentences(knowledge.index.getNode(GRAMMAR_NODE)!);
    expect(sentences.length).toBeGreaterThan(0);
    const objects = lesson!.scene.visual_objects.filter((o) => o.primitive === "en.sentence_highlight");
    expect(objects.length).toBe(sentences.length);
    expect(objects.map((o) => o.params.text)).toEqual(sentences);
    const firstAppear = lesson!.scene.scenes.findIndex((b) =>
      b.actions.some((a) => "target" in a && a.target === objects[0]!.id),
    );
    expect(firstAppear).toBeGreaterThan(0);
  });

  it("要考的题不提前印出来：题面原句不会出现在例句里", () => {
    const q = lesson!.question;
    expect(q).toBeTruthy();
    const stem = q!.stem.replace(/\s+/g, " ");
    for (const o of lesson!.scene.visual_objects) {
      expect(String(o.params.text).replace(/\s+/g, " ")).not.toContain(stem);
    }
  });

  it("场景能过播放器校验：没有未知图元、没有引用不存在的对象", () => {
    const { errors, warnings } = validateSpec(lesson!.scene);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("高亮只框原句里真的有的形式；没有就不框", () => {
    // 整段答法不在（问句常是缩写），退一步框动词本身——它真的在句子里
    expect(highlightFor("is eating", "She’s eating.")).toBe("eating");
    expect(highlightFor("is eating", "It is eating now.")).toBe("is eating");
    // 两种写法都试过，一个都不在句子里 → 不框（不猜 `'m`）
    expect(highlightFor("am", "I’m 22 years old.")).toBeUndefined();
    // 弯撇号 `don’t` 与直撇号 `don't` 是同一个词：归一化之后照样框得上
    expect(highlightFor("don't like / do not like", "I don’t like coffee.")).toBe("don't like");
    expect(highlightFor("don't like / do not like", "I don't like coffee.")).toBe("don't like");
  });

  it("英语词汇节点（跨学科那类）不走语法课的拍序", () => {
    const vocab = composeLesson(VOCAB_NODE, knowledge.index, store);
    expect(vocab).toBeTruthy();
    expect(vocab!.scene.visual_objects).toEqual([]);
  });

  it("语法课出现在课程列表里，且按图谱声明的学段顺序排（不是按写死的难度词表）", () => {
    const lessons = availableLessons(knowledge.index, store, 200);
    const grammar = lessons.filter((l) => l.nodeId.startsWith("en:grammar-"));
    expect(grammar.length).toBeGreaterThan(0);
    const stageOrder = new Map((knowledge.graph.stages ?? []).map((s) => [s.id, s.order]));
    const ranks = lessons.map((l) => stageOrder.get(l.stage) ?? Number.MAX_SAFE_INTEGER);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
