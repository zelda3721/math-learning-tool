import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeFigure } from "../src/figures.js";
import type { EngineContract } from "@mathtutor/schema";
import { createApp } from "../src/app.js";
import { makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

const CONTRACT: EngineContract = {
  contract_version: "open_world_v4",
  tools: [],
  event_types: [],
  artifact_url_base: "/api/v1/media",
};

const GOOD_HTML =
  '<article data-explain="1">' +
  '<section data-beat="0" data-teach="长 8 宽 5"><div data-claim="sides=4">' +
  '<span data-unit="side"></span><span data-unit="side"></span>' +
  '<span data-unit="side"></span><span data-unit="side"></span></div></section>' +
  '<section data-beat="1" data-teach="周长 26"><div data-measure="perimeter=26"></div></section>' +
  "</article>";

/** mock 引擎 plan-only（route=html 分支） */
const GOOD_SPEC = {
  visual_thesis: "周长是四条边的总长",
  visual_objects: [{ id: "rect", primitive: "rectangle", params: { width: 8, height: 5 } }],
  scenes: [{ role: "setup", actions: [], teaching_line: "看这个长方形" }],
  grounding_source: "verified_solution_arithmetic",
};

function mockHtmlFetch(opts: {
  status?: string;
  html?: string | null;
  spec?: unknown;
  gate?: { ok: boolean; errors?: string[]; warnings?: string[] };
  error?: string;
  onBody?: (body: unknown) => void;
}): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("/api/v1/plan")) throw new Error(`unexpected url ${String(url)}`);
    opts.onBody?.(JSON.parse(String(init?.body ?? "{}")));
    return new Response(
      JSON.stringify({
        status: opts.status ?? "ok",
        plan_id: "plan-html1",
        html: opts.html === undefined ? GOOD_HTML : opts.html,
        scene_spec: opts.spec,
        html_gate: opts.gate ?? { ok: true, errors: [], warnings: [] },
        error: opts.error,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function makeApp(engineFetch: typeof fetch) {
  const env = tempFixtureEnv([
    makeQuestion({ id: "wq1", nodeIds: [NODE_A], stem: "长8宽5周长?", answer: "26" }),
  ]);
  env.state.contract = CONTRACT;
  env.state.engineFetch = engineFetch;
  return { app: createApp(env.state), ...env };
}

async function runJob(app: ReturnType<typeof createApp>, body: unknown) {
  const res = await app.request("/api/v1/explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const started = (await res.json()) as { jobId: string };
  // 任务是 fire-and-forget，让微任务队列跑完
  await new Promise((r) => setTimeout(r, 20));
  const jobRes = await app.request(`/api/v1/explain/jobs/${started.jobId}`);
  return (await jobRes.json()) as {
    status: string;
    error?: string;
    note?: string;
    explanation?: { id: string; mode: string; htmlUrl?: string; specUrl?: string; quality: string };
    alternatives?: { id: string; mode: string; specUrl?: string; htmlUrl?: string }[];
  };
}

describe("P6 模型直写讲解页面（web_html）", () => {
  it("合规页面落盘、登记，并按 text/html 带 CSP 发出", async () => {
    let sent: unknown;
    const { app } = makeApp(mockHtmlFetch({ onBody: (b) => (sent = b) }));
    const job = await runJob(app, { questionId: "wq1", mode: "web_html" });

    expect(job.status).toBe("done");
    expect(job.explanation?.mode).toBe("web_html");
    expect(job.explanation?.quality).toBe("good");
    // 走的是 html 路线，而不是悄悄退回 SceneSpec
    expect((sent as { route?: string }).route).toBe("html");

    const htmlUrl = job.explanation!.htmlUrl!;
    expect(htmlUrl).toMatch(/^\/api\/v1\/explain\/html\//);
    const page = await app.request(htmlUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    // 模型写的代码：即使门禁漏了，响应头也不让它联网
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    // 原始产物原样在前，克隆运行时拼在后面（见「data-repeat 由可信运行时展开」一节）
    expect(await page.text()).toContain(GOOD_HTML);
  });

  it("引擎判定门禁不过时不登记——画着假数字比没有讲解糟糕得多", async () => {
    const { app, state } = makeApp(
      mockHtmlFetch({
        html: GOOD_HTML,
        gate: { ok: false, errors: ["rabbits 画成了 17，验证过的解是 12：答案不许画错"] },
      }),
    );
    const job = await runJob(app, { questionId: "wq1", mode: "web_html" });
    expect(job.status).toBe("failed");
    expect(job.error).toContain("答案不许画错");
    expect(state.repo.findExplanation("wq1", undefined, "web_html")).toBeUndefined();
  });

  it("引擎没产出页面时诚实失败", async () => {
    const { app } = makeApp(mockHtmlFetch({ status: "failed", html: null, error: "模型三稿都没过" }));
    const job = await runJob(app, { questionId: "wq1", mode: "web_html" });
    expect(job.status).toBe("failed");
    expect(job.error).toContain("模型三稿都没过");
  });

  it("有未处理建议时降级为 acceptable，但仍然交付", async () => {
    const { app } = makeApp(
      mockHtmlFetch({ gate: { ok: true, errors: [], warnings: ["画面上没有出现验证过的解"] } }),
    );
    const job = await runJob(app, { questionId: "wq1", mode: "web_html" });
    expect(job.status).toBe("done");
    expect(job.explanation?.quality).toBe("acceptable");
  });

  it("两种 web 模式各自独立缓存，不会互相顶掉", async () => {
    const { app, state } = makeApp(mockHtmlFetch({}));
    await runJob(app, { questionId: "wq1", mode: "web_html" });
    expect(state.repo.findExplanation("wq1", undefined, "web_html")?.mode).toBe("web_html");
    expect(state.repo.findExplanation("wq1", undefined, "web")).toBeUndefined();
  });

  it("产物不存在时返回 404 而不是空白页", async () => {
    const { app } = makeApp(mockHtmlFetch({}));
    const res = await app.request("/api/v1/explain/html/nope");
    expect(res.status).toBe(404);
  });
});

describe("both：两条都生成，模型那份没过就自动退回", () => {
  it("发给引擎的是 route=both，而不是只跑一条", async () => {
    let sent: unknown;
    const { app } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC, onBody: (b) => (sent = b) }));
    await runJob(app, { questionId: "wq1", mode: "both" });
    expect((sent as { route?: string }).route).toBe("both");
  });

  it("两份都登记下来——对比语料要的就是这个", async () => {
    const { app, state } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    await runJob(app, { questionId: "wq1", mode: "both" });
    expect(state.repo.findExplanation("wq1", undefined, "web_html")?.htmlUrl).toBeTruthy();
    expect(state.repo.findExplanation("wq1", undefined, "web")?.specUrl).toBeTruthy();
  });

  it("模型那份合规时优先交付它", async () => {
    const { app } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    const job = await runJob(app, { questionId: "wq1", mode: "both" });
    expect(job.status).toBe("done");
    expect(job.explanation?.mode).toBe("web_html");
  });

  it("模型那份没过门禁就退回 SceneSpec，孩子这次仍有讲解看", async () => {
    const { app, state } = makeApp(
      mockHtmlFetch({
        spec: GOOD_SPEC,
        gate: { ok: false, errors: ["heads 标着 35，画面上只有 0 个"] },
      }),
    );
    const job = await runJob(app, { questionId: "wq1", mode: "both" });
    expect(job.status).toBe("done");
    expect(job.explanation?.mode).toBe("web");
    expect(job.explanation?.specUrl).toBeTruthy();
    // 不合规的那份绝不登记
    expect(state.repo.findExplanation("wq1", undefined, "web_html")).toBeUndefined();
  });

  it("两条都不成才算失败，且报出具体原因", async () => {
    const { app } = makeApp(
      mockHtmlFetch({ spec: undefined, gate: { ok: false, errors: ["答案不许画错"] } }),
    );
    const job = await runJob(app, { questionId: "wq1", mode: "both" });
    expect(job.status).toBe("failed");
    expect(job.error).toContain("答案不许画错");
  });

  it("缓存按交付优先级命中：先模型那份，没有再退 SceneSpec", async () => {
    const { app, state } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    await runJob(app, { questionId: "wq1", mode: "both" });
    const res = await app.request("/api/v1/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "wq1", mode: "both" }),
    });
    const body = (await res.json()) as { status: string; explanation?: { mode: string } };
    expect(body.status).toBe("ready");
    expect(body.explanation?.mode).toBe("web_html");
    expect(state.repo.findExplanation("wq1", undefined, "web")).toBeTruthy();
  });
});

describe("并排对比与人工偏好", () => {
  it("both 生成两份后，响应里带上另一份供切换", async () => {
    const { app } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    const job = await runJob(app, { questionId: "wq1", mode: "both" });
    expect(job.status).toBe("done");
    expect(job.explanation?.mode).toBe("web_html");
    // 不给另一份，人就没法把两种讲法摆一起比
    expect(job.alternatives?.map((a) => a.mode)).toEqual(["web"]);
    expect(job.alternatives?.[0]?.specUrl).toBeTruthy();
  });

  it("只生成一份时没有备选，前端不会显示切换器", async () => {
    const { app } = makeApp(mockHtmlFetch({}));
    const job = await runJob(app, { questionId: "wq1", mode: "web_html" });
    expect(job.alternatives).toEqual([]);
  });

  it("投票落库，并按路线可聚合——门禁判不了讲没讲明白", async () => {
    const { app, state } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    const job = await runJob(app, { questionId: "wq1", mode: "both" });
    const id = job.explanation!.id;
    const other = job.alternatives![0]!.id;

    const res = await app.request(`/api/v1/explain/${id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "clear", comparedWith: other }),
    });
    expect(res.status).toBe(200);
    expect(state.repo.getExplanation(id)?.feedbackLabel).toBe("clear");

    const rows = state.repo.explanationSources();
    const html = rows.find((r) => r.mode === "web_html");
    expect(html?.clear_votes).toBe(1);
    expect(html?.confusing_votes).toBe(0);
    // 另一份没投票，不该被算进去
    expect(rows.find((r) => r.mode === "web")?.clear_votes).toBe(0);
  });

  it("再次打开时带出已投的票，不会让人重复表态", async () => {
    const { app } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    const job = await runJob(app, { questionId: "wq1", mode: "both" });
    await app.request(`/api/v1/explain/${job.explanation!.id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "confusing" }),
    });
    const again = await app.request("/api/v1/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "wq1", mode: "both" }),
    });
    const body = (await again.json()) as { explanation?: { feedbackLabel?: string } };
    expect(body.explanation?.feedbackLabel).toBe("confusing");
  });

  it("讲解不存在时 404，标签只认两个值", async () => {
    const { app } = makeApp(mockHtmlFetch({}));
    const miss = await app.request("/api/v1/explain/nope/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "clear" }),
    });
    expect(miss.status).toBe(404);

    const job = await runJob(app, { questionId: "wq1", mode: "web_html" });
    const bad = await app.request(`/api/v1/explain/${job.explanation!.id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "还行吧" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("both：已有旧的动画讲解时，仍要补生成模型那份", () => {
  /** 先用 web 模式生成一份 SceneSpec 讲解，模拟"这题以前讲过" */
  async function seedSpecOnly() {
    const { app, state } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC, html: null }));
    await runJob(app, { questionId: "wq1", mode: "web" });
    return { app, state };
  }

  it("旧的 web 讲解不算 both 的缓存命中——否则模型那份永远没机会生成", async () => {
    const { app, state } = await seedSpecOnly();
    expect(state.repo.findExplanation("wq1", undefined, "web")).toBeTruthy();

    const res = await app.request("/api/v1/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "wq1", mode: "both" }),
    });
    // 必须是 202 去生成，而不是 200 直接把旧的那份还回来
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("generating");
  });

  it("已有 SceneSpec 时只补跑 html，不重复生成计划", async () => {
    const { app, state } = await seedSpecOnly();
    let sent: unknown;
    state.engineFetch = mockHtmlFetch({ spec: GOOD_SPEC, onBody: (b) => (sent = b) });
    const job = await runJob(app, { questionId: "wq1", mode: "both" });

    expect((sent as { route?: string }).route).toBe("html");
    expect(job.status).toBe("done");
    expect(job.explanation?.mode).toBe("web_html");
    // 旧的那份作为对比项出现，而不是被重新生成一遍
    expect(job.alternatives?.map((a) => a.mode)).toEqual(["web"]);
  });

  it("补跑的 html 没过门禁时，退回那份旧的动画讲解", async () => {
    const { app, state } = await seedSpecOnly();
    const before = state.repo.findExplanation("wq1", undefined, "web")!.id;
    state.engineFetch = mockHtmlFetch({
      spec: GOOD_SPEC,
      gate: { ok: false, errors: ["答案不许画错"] },
    });
    const job = await runJob(app, { questionId: "wq1", mode: "both" });
    expect(job.status).toBe("done");
    expect(job.explanation?.id).toBe(before);
    expect(job.explanation?.mode).toBe("web");
  });

  it("模型那份已存在时才算缓存命中，直接秒回", async () => {
    const { app } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    await runJob(app, { questionId: "wq1", mode: "both" });
    const res = await app.request("/api/v1/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "wq1", mode: "both" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; explanation?: { mode: string } };
    expect(body.status).toBe("ready");
    expect(body.explanation?.mode).toBe("web_html");
  });
});

describe("退回时留下原因（否则只能靠猜）", () => {
  it("both 里模型那份被弃用时，任务上留备注说明为什么", async () => {
    const { app } = makeApp(
      mockHtmlFetch({
        spec: GOOD_SPEC,
        gate: { ok: false, errors: ["heads 标着 35，画面上只有 0 个"] },
      }),
    );
    const job = await runJob(app, { questionId: "wq1", mode: "both" });
    expect(job.status).toBe("done");
    expect(job.explanation?.mode).toBe("web");
    expect(job.note).toContain("模型直写那份未采用");
    expect(job.note).toContain("只有 0 个");
  });

  it("两份都成功时不留噪音备注", async () => {
    const { app } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    const job = await runJob(app, { questionId: "wq1", mode: "both" });
    expect(job.note).toBeFalsy();
  });
});

describe("僵尸任务不许永久占位", () => {
  it("久悬的 running 任务被判死，同一道题可以重新生成", async () => {
    const { app, state } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    // 造一个 30 分钟前创建、至今仍 running 的任务（进程中途退出的典型残留）
    const stale = state.repo.createExplainJob({
      questionId: "wq1",
      focusNodeIds: [],
      mode: "both",
    });
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    (state.repo as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE explain_jobs SET created_at = ? WHERE id = ?")
      .run(old, stale);

    const res = await app.request("/api/v1/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "wq1", mode: "both" }),
    });
    const body = (await res.json()) as { status: string; jobId?: string };
    expect(body.status).toBe("generating");
    // 不能把那个僵尸任务的 id 还回来——那样前端会永远轮询一个不会有结果的任务
    expect(body.jobId).not.toBe(stale);
    expect(state.repo.getExplainJob(stale)?.status).toBe("failed");
    expect(state.repo.getExplainJob(stale)?.error).toContain("超时");
  });

  it("刚起的任务不受影响，仍然去重", async () => {
    const { app, state } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    const fresh = state.repo.createExplainJob({
      questionId: "wq1",
      focusNodeIds: [],
      mode: "both",
    });
    const res = await app.request("/api/v1/explain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "wq1", mode: "both" }),
    });
    expect(((await res.json()) as { jobId?: string }).jobId).toBe(fresh);
    expect(state.repo.getExplainJob(fresh)?.status).toBe("running");
  });
});

describe("data-repeat 由可信运行时展开，不经模型的手", () => {
  it("发出的页面拼上了克隆运行时", async () => {
    const { app } = makeApp(mockHtmlFetch({}));
    const job = await runJob(app, { questionId: "wq1", mode: "web_html" });
    const page = await (await app.request(job.explanation!.htmlUrl!)).text();
    // 原始产物原样保留（数据集与排查要的是模型真正写了什么）
    expect(page.startsWith(GOOD_HTML)).toBe(true);
    // 运行时在末尾拼上
    expect(page).toContain("data-unit][data-repeat");
    expect(page).toContain("cloneNode");
  });

  it("落盘的是模型原始产物，不含运行时", async () => {
    const { app, state } = makeApp(mockHtmlFetch({}));
    await runJob(app, { questionId: "wq1", mode: "web_html" });
    const url = state.repo.findExplanation("wq1", undefined, "web_html")!.htmlUrl!;
    const id = url.split("/").pop()!;
    const raw = readFileSync(join(state.config.dataDir, "explanations", `${id}.html`), "utf8");
    expect(raw).toBe(GOOD_HTML);
    expect(raw).not.toContain("cloneNode");
  });
})

it("SceneSpec 端点仍返回纯 JSON——克隆运行时只属于 HTML 那条", async () => {
  const { app } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
  const job = await runJob(app, { questionId: "wq1", mode: "both" });
  const specUrl = job.alternatives!.find((a) => a.mode === "web")!.specUrl!;
  const res = await app.request(specUrl);
  expect(res.headers.get("content-type")).toContain("application/json");
  const text = await res.text();
  expect(text).not.toContain("cloneNode");
  expect(() => JSON.parse(text)).not.toThrow();
})

/**
 * 原题原图要带到引擎去。
 *
 * 讲解要与原图一致，办法不是事后比对两张图像不像，而是让模型根本不重画——
 * 原图当底图、注解叠在上面。前提是这张图真的传过去了，
 * 这条链路断了不会报错，只会悄悄退化成"模型凭题干想象一张图"。
 */
describe("讲解带上原题原图", () => {
  const TINY_JPEG =
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL" +
    "DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
    "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

  function seedWithFigure() {
    const env = tempFixtureEnv([
      makeQuestion({ id: "wq1", nodeIds: [NODE_A], stem: "直角梯形的高是多少?", answer: "6" }),
    ]);
    env.state.contract = CONTRACT;
    env.state.config.figuresDir = mkdtempSync(join(tmpdir(), "figdir-"));
    const { name } = storeFigure(env.state.config.figuresDir, TINY_JPEG);
    // 题库里存的是文件名，讲解链路要自己把它读成 data URL
    const q = env.state.questions.byId.get("wq1")!;
    env.state.questions.byId.set("wq1", { ...q, figureImage: name });
    return env;
  }

  it("题目有原图时，图随请求发给引擎", async () => {
    const env = seedWithFigure();
    let sent: unknown;
    env.state.engineFetch = mockHtmlFetch({ spec: GOOD_SPEC, onBody: (b) => (sent = b) });
    await runJob(createApp(env.state), { questionId: "wq1", mode: "web_html" });
    expect((sent as { figure_image?: string }).figure_image).toBe(TINY_JPEG);
  });

  it("题目没有原图时不带这个字段——引擎据此决定要不要强制放图", async () => {
    const { app, state } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    let sent: unknown;
    state.engineFetch = mockHtmlFetch({ spec: GOOD_SPEC, onBody: (b) => (sent = b) });
    await runJob(app, { questionId: "wq1", mode: "web_html" });
    expect((sent as { figure_image?: string }).figure_image).toBeUndefined();
  });

  it("自由题（不经题库）也不带图", async () => {
    const { app, state } = makeApp(mockHtmlFetch({ spec: GOOD_SPEC }));
    let sent: unknown;
    state.engineFetch = mockHtmlFetch({ spec: GOOD_SPEC, onBody: (b) => (sent = b) });
    await runJob(app, { problem: "一个长方形长 8 宽 5，周长多少？", mode: "web_html" });
    expect((sent as { figure_image?: string }).figure_image).toBeUndefined();
  });
});
