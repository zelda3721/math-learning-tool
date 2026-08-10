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

const GOOD_SPEC = {
  visual_thesis: "周长是四条边的总长",
  visual_objects: [{ id: "rect", primitive: "rectangle", params: { width: 8, height: 5 } }],
  scenes: [{ role: "setup", actions: [{ op: "appear", target: "rect" }], teaching_line: "看这个长方形" }],
  grounding_source: "verified_solution_arithmetic",
};

/** mock 引擎 plan-only：返回 JSON（区别于 chat 的 SSE） */
function mockPlanFetch(opts: { status?: string; spec?: unknown; error?: string }): typeof fetch {
  return (async (url: unknown) => {
    if (!String(url).includes("/api/v1/plan")) throw new Error(`unexpected url ${String(url)}`);
    return new Response(
      JSON.stringify({
        status: opts.status ?? "ok",
        plan_id: "plan-mock1",
        scene_spec: opts.spec === undefined ? GOOD_SPEC : opts.spec,
        error: opts.error,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function makeWebApp(engineFetch: typeof fetch) {
  const env = tempFixtureEnv([
    makeQuestion({ id: "wq1", nodeIds: [NODE_A], stem: "长8宽5周长?", answer: "26" }),
  ]);
  env.state.contract = CONTRACT;
  env.state.engineFetch = engineFetch;
  return { app: createApp(env.state), ...env };
}

async function post(app: ReturnType<typeof makeWebApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function waitJob(app: ReturnType<typeof makeWebApp>["app"], jobId: string) {
  for (let i = 0; i < 50; i++) {
    const body = await (await app.request(`/api/v1/explain/jobs/${jobId}`)).json();
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job never settled");
}

describe("explain web mode (P4 default)", () => {
  it("default mode is web: plan-only -> spec stored -> served -> cache hit", async () => {
    const { app } = makeWebApp(mockPlanFetch({}));
    const first = await post(app, "/api/v1/explain", { questionId: "wq1" }); // 不传 mode = web
    expect(first.status).toBe(202);
    expect(first.body.mode).toBe("web");

    const job = await waitJob(app, first.body.jobId);
    expect(job.status).toBe("done");
    expect(job.explanation.mode).toBe("web");
    expect(job.explanation.specUrl).toMatch(/^\/api\/v1\/explain\/specs\//);
    expect(job.explanation.quality).toBe("good");

    // spec 可取回且与引擎产物一致
    const specRes = await app.request(job.explanation.specUrl);
    expect(specRes.status).toBe(200);
    const spec = await specRes.json();
    expect(spec.visual_thesis).toBe(GOOD_SPEC.visual_thesis);
    expect(spec.visual_objects[0].primitive).toBe("rectangle");

    // 缓存命中（web 模式）
    const second = await post(app, "/api/v1/explain", { questionId: "wq1" });
    expect(second.body.status).toBe("ready");
    expect(second.body.explanation.specUrl).toBe(job.explanation.specUrl);
  });

  it("web and video caches are separate per mode", async () => {
    const { app, repo } = makeWebApp(mockPlanFetch({}));
    const first = await post(app, "/api/v1/explain", { questionId: "wq1", mode: "web" });
    await waitJob(app, first.body.jobId);
    // video 模式不命中 web 缓存 → 走生成（mock 是 plan 端点会抛 unexpected url → job failed）
    const video = await post(app, "/api/v1/explain", { questionId: "wq1", mode: "video" });
    expect(video.body.status).toBe("generating");
    const vJob = await waitJob(app, video.body.jobId);
    expect(vJob.status).toBe("failed");
    expect(repo.findExplanation("wq1", undefined, "web")).toBeTruthy();
    expect(repo.findExplanation("wq1", undefined, "video")).toBeUndefined();
  });

  it("empty spec fails the job honestly", async () => {
    const { app } = makeWebApp(mockPlanFetch({ spec: { visual_objects: [], scenes: [] } }));
    const first = await post(app, "/api/v1/explain", { questionId: "wq1" });
    const job = await waitJob(app, first.body.jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("为空");
  });

  it("free-text problem works without a question and caches by content hash", async () => {
    const { app } = makeWebApp(mockPlanFetch({}));
    const first = await post(app, "/api/v1/explain", {
      problem: "一个正方形边长 6 厘米，周长是多少？",
      grade: "elementary_lower",
    });
    expect(first.status).toBe(202);
    const job = await waitJob(app, first.body.jobId);
    expect(job.status).toBe("done");
    expect(job.explanation.questionId).toMatch(/^free-/);

    const second = await post(app, "/api/v1/explain", {
      problem: "一个正方形边长 6 厘米，周长是多少？",
      grade: "elementary_lower",
    });
    expect(second.body.status).toBe("ready");
    expect(second.body.explanation.specUrl).toBe(job.explanation.specUrl);
  });

  it("engine plan failure surfaces error, fallback already delivered", async () => {
    const { app } = makeWebApp(mockPlanFetch({ status: "failed", spec: null, error: "solve 失败" }));
    const first = await post(app, "/api/v1/explain", { questionId: "wq1" });
    expect(first.body.fallback.rootNode?.name).toBeTruthy();
    const job = await waitJob(app, first.body.jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("solve");
  });
});
