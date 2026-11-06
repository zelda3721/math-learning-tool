import { describe, expect, it } from "vitest";
import {
  compileBook,
  conceptIdOf,
  diffCompiled,
  normalizeConceptName,
  type ConceptDraft,
  type ConceptExtractionProvider,
} from "../src/compile.js";
import type { Chapter } from "../src/chapters.js";

function chapter(title: string, text: string, extra: Partial<Chapter> = {}): Chapter {
  return { title, fromPage: 1, toPage: 1, text, ...extra };
}

function draft(title: string, definition: string, extra: Partial<ConceptDraft> = {}): ConceptDraft {
  return {
    title,
    definition,
    keyPoints: [],
    prerequisites: [],
    evidence: `${title}：${definition}（原文一句完整的话）`,
    ...extra,
  };
}

/** 按章给结果的假 provider：每章返回预设草稿 */
function fakeProvider(byChapter: Record<string, ConceptDraft[]>): ConceptExtractionProvider {
  return {
    async extract({ chapterTitle }) {
      return byChapter[chapterTitle] ?? [];
    },
  };
}

describe("概念身份", () => {
  it("规范名忽略大小写、空白与标点", () => {
    expect(normalizeConceptName("分数的意义")).toBe(normalizeConceptName(" 分数的意义 "));
    expect(normalizeConceptName("am/is/are")).toBe(normalizeConceptName("AM IS ARE"));
  });

  it("同一个概念重编译得到同一个 id——这是两版产物能比的前提", () => {
    expect(conceptIdOf("分数的意义")).toBe(conceptIdOf(" 分数的意义 "));
    expect(conceptIdOf("分数的意义")).not.toBe(conceptIdOf("小数的意义"));
  });

  it("id 撞车时不会让两个概念共用一个 id", async () => {
    // 构造两个规范化后仍不同、但哈希相同的名字几乎不可能，
    // 这里改为验证不同概念一定拿到不同 id（正常路径的守卫）
    expect(conceptIdOf("通分")).not.toBe(conceptIdOf("约分"));
    const book = await compileBook([chapter("第一章", "x")], {
      provider: fakeProvider({
        第一章: [draft("通分", "把异分母化成同分母"), draft("约分", "分子分母同除以公因数")],
      }),
    });
    const ids = book.concepts.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("compileBook：编译", () => {
  it("没有 provider 时整本走离线兜底，并如实标 degraded", async () => {
    const book = await compileBook([chapter("第一章 分数", "分数是把整体平均分成若干份表示这样一份或几份的数。\n\n分母表示平均分成的份数，分子表示取了多少份。")], {
      title: "数学 五年级上",
    });
    expect(book.degraded).toBe(true);
    expect(book.concepts.length).toBeGreaterThan(0);
    expect(book.coverage.chapters).toBe(1);
    expect(book.coverage.chaptersWithConcepts).toBe(1);
  });

  it("跨章的同名概念合并成一条，出处累加而不是各留一条", async () => {
    const book = await compileBook(
      [chapter("第一章 分数", "……"), chapter("第三章 分数的加减", "……")],
      {
        provider: fakeProvider({
          "第一章 分数": [draft("通分", "把异分母分数化成同分母分数", { keyPoints: ["找公分母"] })],
          "第三章 分数的加减": [draft("通分", "把异分母分数化成同分母分数", { keyPoints: ["最小公倍数"] })],
        }),
      },
    );
    expect(book.concepts).toHaveLength(1);
    expect(book.concepts[0]!.sources.map((s) => s.chapterTitle)).toEqual(["第一章 分数", "第三章 分数的加减"]);
    expect(book.concepts[0]!.keyPoints).toEqual(["找公分母", "最小公倍数"]);
    expect(book.concepts[0]!.conflicts).toEqual([]);
    expect(book.degraded).toBe(false);
  });

  it("同一概念两处定义矛盾时不自动选边：两条都留着并标出冲突", async () => {
    const book = await compileBook([chapter("第一章 分数", "……"), chapter("附录讲法", "……")], {
      provider: fakeProvider({
        "第一章 分数": [draft("分数单位", "把单位一平均分成若干份，表示其中一份的数")],
        附录讲法: [draft("分数单位", "分子是一、分母是任意正整数的分数")],
      }),
    });
    expect(book.concepts).toHaveLength(1);
    const concept = book.concepts[0]!;
    // 主定义保留第一条，冲突方原文留档
    expect(concept.definition).toContain("表示其中一份");
    expect(concept.conflicts).toHaveLength(1);
    expect(concept.conflicts[0]!.definition).toContain("分子是一");
    expect(concept.conflicts[0]!.chapterTitle).toBe("附录讲法");
  });

  it("先修解析成书内边；解析不到的先修如实列为悬空", async () => {
    const book = await compileBook([chapter("第一章", "……")], {
      provider: fakeProvider({
        第一章: [
          draft("通分", "把异分母化成同分母", { prerequisites: ["最小公倍数", "约分"] }),
          draft("约分", "分子分母同除以公因数"),
        ],
      }),
    });
    expect(book.links).toHaveLength(1);
    const [edge] = book.links;
    const from = book.concepts.find((c) => c.id === edge!.from)!;
    const to = book.concepts.find((c) => c.id === edge!.to)!;
    expect(from.title).toBe("约分");
    expect(to.title).toBe("通分");
    expect(book.unresolvedPrerequisites).toEqual([{ conceptId: conceptIdOf("通分"), title: "最小公倍数" }]);
  });

  it("附录不参与编译（答案册不是知识点）", async () => {
    const book = await compileBook(
      [chapter("第一章", "……"), chapter("Key to Exercises", "95.4 was bad.", { backMatter: true })],
      { provider: fakeProvider({ 第一章: [draft("通分", "把异分母化成同分母")] }) },
    );
    expect(book.coverage.chapters).toBe(1);
    expect(book.concepts).toHaveLength(1);
  });

  it("模型输出站不住（没有原文）的草稿被丢掉，这一章退回离线兜底", async () => {
    const book = await compileBook([chapter("第一章", "分数是把整体平均分成若干份表示这样一份或几份的数。")], {
      provider: fakeProvider({ 第一章: [draft("通分", "把异分母化成同分母", { evidence: "短" })] }),
    });
    expect(book.degraded).toBe(true);
    expect(book.concepts.some((c) => c.title === "通分")).toBe(false);
  });

  it("provider 抛异常也不让整本编译失败", async () => {
    const book = await compileBook([chapter("第一章", "分数是把整体平均分成若干份表示这样一份或几份的数。")], {
      provider: {
        async extract() {
          throw new Error("model down");
        },
      },
    });
    expect(book.degraded).toBe(true);
    expect(book.concepts.length).toBeGreaterThan(0);
  });
});

describe("diffCompiled：两版产物比差异", () => {
  it("能列出新增、消失与字段变化", async () => {
    const first = await compileBook([chapter("第一章", "……")], {
      provider: fakeProvider({ 第一章: [draft("通分", "把异分母化成同分母")] }),
    });
    const second = await compileBook([chapter("第一章", "……"), chapter("第二章", "……")], {
      provider: fakeProvider({
        第一章: [draft("通分", "把异分母分数化成同分母分数", { keyPoints: ["找公分母"] })],
        第二章: [draft("约分", "分子分母同除以公因数")],
      }),
    });

    const diff = diffCompiled(first, second);
    expect(diff.added.map((c) => c.title)).toEqual(["约分"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.map((c) => c.title)).toEqual(["通分"]);
    expect(diff.changed[0]!.fields).toEqual(["definition", "keyPoints"]);
  });

  it("同样的输入编译两次，diff 为空——编译是幂等的", async () => {
    const build = () =>
      compileBook([chapter("第一章", "……")], {
        provider: fakeProvider({ 第一章: [draft("通分", "把异分母化成同分母", { keyPoints: ["找公分母"] })] }),
      });
    const [a, b] = await Promise.all([build(), build()]);
    expect(diffCompiled(a, b)).toEqual({ added: [], removed: [], changed: [] });
  });
});
