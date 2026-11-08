import { describe, expect, it } from "vitest";
import { compileBook, conceptIdOf, diffCompiled, type ConceptDraft, type ConceptExtractionProvider } from "../src/compile.js";

/**
 * 「教材编译幂等」到底承诺什么。
 *
 * 之前这句话只在假 provider 上验过——它证明的是**管道**幂等，不是**模型**幂等。
 * 真实情况是：本地模型 temperature 0.2，同一批 6 章跑 5 次，概念数是 25/25/25/23/27。
 * 所以"同一本书重编译出逐字相同的产物"是**假的**，不能写进验收标准。
 *
 * 真正立得住的只有下面这三条，逐条有测试：
 * 1. 管道确定：同一批草稿、同样的输入，编出来的产物逐字相同，顺序变了也一样；
 * 2. 身份稳定：概念 id 由规范名派生，模型把标题写成别的写法（大小写/空格/标点/全半角）
 *    仍然是同一个 id——这是"两版产物能对比"的前提；
 * 3. 边界写明：模型换了措辞就是另一个 id。这不是 bug，是已知边界，
 *    所以它被钉成一条测试，免得以后有人误以为"应该自动合并"。
 * 对齐质量则交给 data/golden/align 评测集（scripts/align_eval.mjs），不靠幂等性代理。
 */

function chapter(title: string, text: string) {
  return { title, fromPage: 1, toPage: 1, text };
}

const BODY = "通分是把异分母分数化成同分母分数。约分是分子分母同除以公因数。";

function drafts(): ConceptDraft[] {
  return [
    { title: "通分", definition: "把异分母分数化成同分母分数。", keyPoints: ["找公分母"], prerequisites: ["约分"], evidence: "通分是把异分母分数化成同分母分数。" },
    { title: "约分", definition: "分子分母同除以公因数。", keyPoints: [], prerequisites: [], evidence: "约分是分子分母同除以公因数。" },
  ];
}

function fixedProvider(list: ConceptDraft[]): ConceptExtractionProvider {
  return {
    async extract() {
      // 每次都给新对象：避免"其实复用同一个引用"这种假绿
      return list.map((d) => ({ ...d, keyPoints: [...d.keyPoints], prerequisites: [...d.prerequisites] }));
    },
  };
}

describe("承诺一：管道确定", () => {
  it("同样的草稿编两次，产物逐字相同", async () => {
    const chapters = [chapter("第一章 分数", BODY)];
    const a = await compileBook(chapters, { title: "数学", provider: fixedProvider(drafts()) });
    const b = await compileBook(chapters, { title: "数学", provider: fixedProvider(drafts()) });
    expect(b).toEqual(a);
    expect(diffCompiled(a, b)).toEqual({ added: [], removed: [], changed: [] });
  });

  it("模型返回的草稿顺序变了，产物不变（合并前按名归一，不按到达顺序）", async () => {
    const chapters = [chapter("第一章 分数", BODY)];
    const forward = await compileBook(chapters, { title: "数学", provider: fixedProvider(drafts()) });
    const reversed = await compileBook(chapters, { title: "数学", provider: fixedProvider([...drafts()].reverse()) });
    expect(reversed).toEqual(forward);
  });
});

describe("承诺二：概念身份稳定", () => {
  it("标题的大小写、空格、标点、全半角差异不改变 id", () => {
    const variants = ["通分", " 通分 ", "通分。", "通 分", "通分！"];
    const ids = new Set(variants.map((v) => conceptIdOf(v)));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(conceptIdOf("通分"));
  });

  it("英文标题的不同写法同样归一（Am/Is/Are vs am is are）", () => {
    expect(conceptIdOf("Am/Is/Are")).toBe(conceptIdOf("am is are"));
  });

  it("模型换了个大小写写同一概念：合并成一条，不会变成两条", async () => {
    const chapters = [chapter("第一章 分数", BODY), chapter("第二章 分数", BODY)];
    const book = await compileBook(chapters, {
      title: "数学",
      provider: {
        async extract({ chapterTitle }) {
          return [
            {
              title: chapterTitle.includes("第一章") ? "通分" : " 通分 ",
              definition: "把异分母分数化成同分母分数。",
              keyPoints: [],
              prerequisites: [],
              evidence: "通分是把异分母分数化成同分母分数。",
            },
          ];
        },
      },
    });
    expect(book.concepts).toHaveLength(1);
    expect(book.concepts[0]!.sources).toHaveLength(2);
  });
});

describe("承诺三：边界（模型换措辞就是另一个概念）", () => {
  it("标题措辞不同 → id 不同，不会被强行合并", () => {
    expect(conceptIdOf("通分")).not.toBe(conceptIdOf("通分与约分"));
  });

  it("所以两版产物比出来的差异，一部分是模型噪声——diff 只如实报告，不猜测", async () => {
    const chapters = [chapter("第一章 分数", BODY)];
    const first = await compileBook(chapters, {
      title: "数学",
      provider: fixedProvider([{ ...drafts()[0]!, title: "通分" }]),
    });
    const second = await compileBook(chapters, {
      title: "数学",
      provider: fixedProvider([{ ...drafts()[0]!, title: "通分（异分母化同分母）" }]),
    });
    const diff = diffCompiled(first, second);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.changed).toHaveLength(0);
  });
});
