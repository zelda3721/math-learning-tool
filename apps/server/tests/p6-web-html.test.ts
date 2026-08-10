import { describe, expect, it } from "vitest";
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
function mockHtmlFetch(opts: {
  status?: string;
  html?: string | null;
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
    explanation?: { mode: string; htmlUrl?: string; quality: string };
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
    expect(await page.text()).toBe(GOOD_HTML);
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
