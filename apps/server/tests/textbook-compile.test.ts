import { describe, expect, it } from "vitest";
import { parseConceptDrafts } from "../src/textbookCompiler.js";
import { makeApp } from "./helpers.js";

/**
 * 知识编译接口：书 → 概念（跨章合并、带出处），落 data/knowledge/compiled/，
 * 同样不碰图谱。
 */

const PAGES = [
  { page: 1, text: "第一章 分数的意义\n把一个整体平均分成若干份，表示这样一份或几份的数叫分数。" },
  { page: 2, text: "第三章 分数的加减\n通分是把异分母分数化成同分母分数。分数的分母表示平均分成的份数。" },
];

async function post(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /api/v1/textbook/compile", () => {
  it("没有 provider 也能编译（离线兜底），并如实标 degraded", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/compile", { title: "数学 五年级上", pages: PAGES });

    expect(res.status).toBe(200);
    expect(res.body.concepts.length).toBeGreaterThan(0);
    expect(res.body.degraded).toBe(true);
    expect(res.body.note).toContain("图谱不会被修改");
    expect(res.body.markdownDir).toBeTruthy();
  });

  it("注入了 provider 就用它，跨章同名概念合并成一条", async () => {
    const { app } = makeApp([], {
      textbookProvider: {
        async extract({ chapterTitle }) {
          return [
            {
              title: "通分",
              definition: "把异分母分数化成同分母分数。",
              keyPoints: chapterTitle.includes("加减") ? ["最小公倍数"] : ["公分母"],
              prerequisites: [],
              evidence: `通分是把异分母分数化成同分母分数（${chapterTitle}原文）。`,
            },
          ];
        },
      },
    });

    const res = await post(app, "/api/v1/textbook/compile", { title: "数学", pages: PAGES });
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(false);
    const merged = res.body.concepts.filter((c: { title: string }) => c.title === "通分");
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceCount).toBe(2);
    expect(merged[0].keyPointCount).toBe(2);
  });

  it("编译产物能按名字读回，图谱一个节点都不增加", async () => {
    const { app, state } = makeApp([], {
      textbookProvider: {
        async extract() {
          return [
            {
              title: "通分",
              definition: "把异分母分数化成同分母分数。",
              keyPoints: [],
              prerequisites: [],
              evidence: "通分是把异分母分数化成同分母分数。",
            },
          ];
        },
      },
    });
    const before = state.knowledge.graph.nodes.length;

    await post(app, "/api/v1/textbook/compile", { title: "数学 五年级上", pages: PAGES });
    const res = await app.request(`/api/v1/textbook/compiled/${encodeURIComponent("数学 五年级上")}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { concepts: { title: string }[] };
    expect(body.concepts.map((c) => c.title)).toContain("通分");
    expect(state.knowledge.graph.nodes.length).toBe(before);
  });

  it("没编译过的书读回来是 404", async () => {
    const { app } = makeApp([]);
    const res = await app.request("/api/v1/textbook/compiled/没有这本书");
    expect(res.status).toBe(404);
  });
});

describe("parseConceptDrafts：模型输出解析", () => {
  it("认得裸数组、```json 围栏和 {concepts:[...]} 三种写法", () => {
    const draft = '{"title":"通分","definition":"把异分母化成同分母","keyPoints":["找公分母"],"prerequisites":[],"evidence":"通分是把异分母分数化成同分母分数。"}';
    for (const raw of [`[${draft}]`, "```json\n[" + draft + "]\n```", `{"concepts":[${draft}]}`]) {
      expect(parseConceptDrafts(raw)).toEqual([
        {
          title: "通分",
          definition: "把异分母化成同分母",
          keyPoints: ["找公分母"],
          prerequisites: [],
          evidence: "通分是把异分母分数化成同分母分数。",
        },
      ]);
    }
  });

  it("模型在 JSON 前后加了解释也能挖出来", () => {
    const raw = '好的，这是结果：\n[{"title":"通分","definition":"d","keyPoints":[],"prerequisites":[],"evidence":"e"}]\n希望有帮助。';
    expect(parseConceptDrafts(raw)).toHaveLength(1);
  });

  it("完全解析不出来时返回空数组，不抛异常（交给离线兜底）", () => {
    expect(parseConceptDrafts("模型今天不想说话")).toEqual([]);
    expect(parseConceptDrafts("")).toEqual([]);
  });
});
