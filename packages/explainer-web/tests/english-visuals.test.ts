import { describe, expect, it } from "vitest";
import type { SceneSpec } from "@mathtutor/schema";
import { foldBeats } from "../src/fold.js";
import { solveScene, highlightSpans } from "../src/render/scene.js";
import { layoutFlowed } from "../src/render/layout.js";

/**
 * 英语语法课的图元（`en.sentence_highlight`）。
 *
 * 锁三件事：
 * 1. 句子照原样显示——撇号、省略号、句中大写都不能被"整理"掉；
 * 2. 高亮只落在**整词**上：练 `work` 时不能把 `working` 里的 `work` 框上，
 *    那正好把"两种形式不一样"教反了；
 * 3. 找不到就不框（不是"找不到就随便框一个"）。
 */

const spec = (objects: unknown[]): SceneSpec =>
  ({ visual_objects: objects, scenes: [{ role: "example", actions: [] }] }) as unknown as SceneSpec;

function sentenceOf(objects: unknown[]) {
  const scene = solveScene(foldBeats(spec(objects))[0]!, 900, 420);
  const shape = scene.flowed.find((s) => s.kind === "sentence");
  if (shape?.kind !== "sentence") throw new Error("没有句子图元");
  return { scene, shape };
}

describe("英语句子图元", () => {
  it("句子原样保留（撇号、省略号、问号都不动），高亮落在原句对应的字符区间", () => {
    const text = "I don’t like coffee, but she likes it.";
    const { shape } = sentenceOf([
      { id: "s1", primitive: "en.sentence_highlight", params: { text, highlight: "don’t like" } },
    ]);
    expect(shape.text).toBe(text);
    expect(shape.highlights).toHaveLength(1);
    const span = shape.highlights[0]!;
    expect(text.slice(span.start, span.end)).toBe("don’t like");
  });

  it("整词匹配：练 work 不框 working", () => {
    expect(highlightSpans("I am working now.", "work")).toEqual([]);
    expect(highlightSpans("I work in a shop.", "work")).toEqual([{ start: 2, end: 6 }]);
  });

  it("找不到要框的那一段就整句平着显示，不猜别的词", () => {
    const { shape } = sentenceOf([
      { id: "s1", primitive: "en.sentence_highlight", params: { text: "I’m 22 years old.", highlight: "am" } },
    ]);
    expect(shape.highlights).toEqual([]);
  });

  it("同一句里出现两次就框两处（不是只框第一处）", () => {
    const text = "Does she play? Yes, she does.";
    const spans = highlightSpans(text, "does");
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Does", "does"]);
  });

  it("没有文字的句子图元上报语义问题，而不是画一个空框", () => {
    const scene = solveScene(
      foldBeats(spec([{ id: "s1", primitive: "en.sentence_highlight", params: {} }]))[0]!,
      900,
      420,
    );
    expect(scene.flowed.some((s) => s.kind === "sentence")).toBe(false);
    expect(scene.issues.some((i) => i.kind === "semantic")).toBe(true);
  });

  it("词卡带释义，布局给正反面各自的基线", () => {
    const scene = solveScene(
      foldBeats(
        spec([{ id: "c1", primitive: "en.vocab_card", params: { term: "half past eight", meaning: "八点半" } }]),
      )[0]!,
      900,
      420,
    );
    const card = scene.flowed.find((s) => s.kind === "card");
    if (card?.kind !== "card") throw new Error("没有词卡图元");
    expect(card.head).toBe("half past eight");
    const { items } = layoutFlowed(scene, { width: 900, height: 420 });
    const placed = items.find((i) => i.kind === "card");
    if (placed?.kind !== "card") throw new Error("词卡没有被布局");
    expect(placed.sub).toBe("八点半");
    expect(placed.subBaseline).toBeGreaterThan(placed.headBaseline);
    expect(placed.box.x).toBeGreaterThanOrEqual(0);
    expect(placed.box.x + placed.box.w).toBeLessThanOrEqual(900);
  });

  it("句子太长就缩字号，不截断——半句例句教不了语法", () => {
    const text =
      "This is a fairly long English sentence that will not fit at the default size on a narrow screen, and it must stay complete.";
    const scene = solveScene(
      foldBeats(spec([{ id: "s1", primitive: "en.sentence_highlight", params: { text } }]))[0]!,
      480,
      420,
    );
    const { items } = layoutFlowed(scene, { width: 480, height: 420 });
    const placed = items.find((i) => i.kind === "sentence");
    if (placed?.kind !== "sentence") throw new Error("句子没有被布局");
    expect(placed.text).toBe(text);
    expect(placed.fontSize).toBeLessThan(34);
    expect(placed.fontSize).toBeGreaterThanOrEqual(16);
  });
});
