import { describe, expect, it } from "vitest";
import { parseConceptDrafts } from "../src/textbookCompiler.js";
import { makeApp } from "./helpers.js";
import { miniPdfBase64 } from "./pdfFixture.js";

/**
 * 知识编译接口：书 → 概念（跨章合并、带出处），落 data/knowledge/compiled/，
 * 同样不碰图谱。编译是**后台任务**：POST 返回 202 + jobId，轮询看进度与结果。
 */

const PAGES = [
  { page: 1, text: "第一章 分数的意义\n把一个整体平均分成若干份，表示这样一份或几份的数叫分数。" },
  { page: 2, text: "第三章 分数的加减\n通分是把异分母分数化成同分母分数。分数的分母表示平均分成的份数。" },
];

type App = ReturnType<typeof makeApp>["app"];

async function post(app: App, url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 轮询任务到结束（进程内异步，通常一两轮就完） */
async function waitJob(app: App, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const res = await app.request(`/api/v1/textbook/compile/${jobId}`);
    const job = (await res.json()) as { status: string; progress: Record<string, unknown>; result: any; error: string | null };
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("任务没有在预期时间内结束");
}

const provider = (definition = "把异分母分数化成同分母分数。") => ({
  async extract({ chapterTitle }: { chapterTitle: string }) {
    return [
      {
        title: "通分",
        definition,
        keyPoints: chapterTitle.includes("加减") ? ["最小公倍数"] : ["公分母"],
        prerequisites: [],
        // 引文必须是正文里真实存在的一句，否则会被判成未定位（见下方专门的那条测试）
        evidence: "通分是把异分母分数化成同分母分数。",
      },
    ];
  },
});

describe("POST /api/v1/textbook/compile", () => {
  it("返回 202 + jobId，任务跑完后结果里有概念摘要", async () => {
    const { app } = makeApp([], { textbookProvider: provider() });
    const res = await post(app, "/api/v1/textbook/compile", { title: "数学 五年级上", pages: PAGES });

    expect(res.status).toBe(202);
    expect(typeof res.body.jobId).toBe("string");
    expect(res.body.status).toBe("running");

    const job = await waitJob(app, String(res.body.jobId));
    expect(job.status).toBe("done");
    expect(job.result.concepts.length).toBeGreaterThan(0);
    expect(job.result.note).toContain("图谱不会被修改");
    expect(job.result.markdownDir).toBeTruthy();
    expect(job.result.degraded).toBe(false);
  });

  it("进度里能看见编到第几章——十几分钟的任务不能只有一个「在跑」", async () => {
    const { app } = makeApp([], { textbookProvider: provider() });
    const res = await post(app, "/api/v1/textbook/compile", { title: "数学", pages: PAGES });
    const job = await waitJob(app, String(res.body.jobId));

    expect(job.progress).toMatchObject({ stage: "compile", total: 2 });
    expect(job.progress.current).toBe(2);
  });

  it("跨章同名概念合并成一条：出处累加、要点并集", async () => {
    const { app } = makeApp([], { textbookProvider: provider() });
    const res = await post(app, "/api/v1/textbook/compile", { title: "数学", pages: PAGES });
    const job = await waitJob(app, String(res.body.jobId));

    const merged = job.result.concepts.filter((c: { title: string }) => c.title === "通分");
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceCount).toBe(2);
    expect(merged[0].keyPointCount).toBe(2);
    expect(merged[0].verified).toBe(true);
    // 同一段引文只在一章里真实出现过（另一章讲的是分数的意义），
    // 所以出处 2 条、可定位 1 条——引文核对是**按来源**判的，不是按概念
    expect(merged[0].verifiedSourceCount).toBe(1);
  });

  it("模型编造的引文不算出处：概念标 verified=false，引文条数仍是 1 但可定位条数为 0", async () => {
    const { app } = makeApp([], {
      textbookProvider: {
        async extract() {
          return [
            {
              title: "通分",
              definition: "把异分母分数化成同分母分数。",
              keyPoints: [],
              prerequisites: [],
              evidence: "通分就是把分子分母同时乘以同一个数。",
            },
          ];
        },
      },
    });

    const res = await post(app, "/api/v1/textbook/compile", { title: "数学", pages: PAGES });
    const job = await waitJob(app, String(res.body.jobId));
    const concept = job.result.concepts.find((c: { title: string }) => c.title === "通分");
    expect(concept.verified).toBe(false);
    expect(concept.verifiedSourceCount).toBe(0);
    expect(job.result.coverage.verifiedConcepts).toBe(0);
  });

  it("没有 provider 也能编译（离线兜底），并如实标 degraded", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/compile", { title: "数学 五年级上", pages: PAGES });
    const job = await waitJob(app, String(res.body.jobId));

    expect(job.status).toBe("done");
    expect(job.result.concepts.length).toBeGreaterThan(0);
    expect(job.result.degraded).toBe(true);
  });

  it("编译产物能按名字读回，图谱一个节点都不增加", async () => {
    const { app, state } = makeApp([], { textbookProvider: provider() });
    const before = state.knowledge.graph.nodes.length;

    const res = await post(app, "/api/v1/textbook/compile", { title: "数学 五年级上", pages: PAGES });
    await waitJob(app, String(res.body.jobId));

    const read = await app.request(`/api/v1/textbook/compiled/${encodeURIComponent("数学 五年级上")}`);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { concepts: { title: string }[] };
    expect(body.concepts.map((c) => c.title)).toContain("通分");
    expect(state.knowledge.graph.nodes.length).toBe(before);
  });

  it("任务不存在时轮询返回 404", async () => {
    const { app } = makeApp([]);
    const res = await app.request("/api/v1/textbook/compile/没有这个任务");
    expect(res.status).toBe(404);
  });

  it("没编译过的书读回来是 404", async () => {
    const { app } = makeApp([]);
    const res = await app.request("/api/v1/textbook/compiled/没有这本书");
    expect(res.status).toBe(404);
  });
});

describe("全局并发闸", () => {
  it("两本书同时编译，同时在飞的模型请求数仍是配置的那一个数（不是翻倍）", async () => {
    let inFlight = 0;
    let peak = 0;
    const slowProvider = {
      async extract() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
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
    };
    const { app, state } = makeApp([], { textbookProvider: slowProvider });
    const limit = state.config.textbookCompileConcurrency;

    const [a, b] = await Promise.all([
      post(app, "/api/v1/textbook/compile", { title: "书A", pages: PAGES }),
      post(app, "/api/v1/textbook/compile", { title: "书B", pages: PAGES }),
    ]);
    await Promise.all([waitJob(app, String(a.body.jobId)), waitJob(app, String(b.body.jobId))]);

    expect(peak).toBeLessThanOrEqual(limit);
    // 两台并发确实发生过（否则这条测试证明不了闸在工作）
    expect(peak).toBeGreaterThanOrEqual(2);
  });
});

describe("PDF 直接入编译（家长上传的真实路径）", () => {
  it("传 pdfBase64 就能编，不用前端先切页", async () => {
    const { app } = makeApp([], { textbookProvider: provider() });
    const res = await post(app, "/api/v1/textbook/compile", {
      title: "PDF 教材",
      pdfBase64: miniPdfBase64("Fraction: a number that names part of a whole."),
    });

    expect(res.status).toBe(202);
    const job = await waitJob(app, String(res.body.jobId));
    expect(job.status).toBe("done");
    expect(job.result.concepts.length).toBeGreaterThan(0);
  });

  it("没有文本层的 PDF（扫描版）→ 422 并说清原因，而不是编出空章节", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/compile", {
      title: "扫描版",
      pdfBase64: miniPdfBase64(""),
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("扫描版");
  });

  it("坏 PDF → 400，不抛 500", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/compile", { pdfBase64: Buffer.from("not a pdf").toString("base64") });
    expect(res.status).toBe(400);
  });

  it("什么都不给 → 400", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/compile", { title: "空的" });
    expect(res.status).toBe(400);
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
