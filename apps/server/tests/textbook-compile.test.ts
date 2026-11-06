import { describe, expect, it } from "vitest";
import { parseConceptDrafts } from "../src/textbookCompiler.js";
import { makeApp } from "./helpers.js";

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
        evidence: `通分是把异分母分数化成同分母分数（${chapterTitle}里的原文）。`,
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
