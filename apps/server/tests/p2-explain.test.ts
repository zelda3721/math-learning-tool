import { describe, expect, it } from "vitest";
import type { EngineContract } from "@mathtutor/schema";
import { createApp } from "../src/app.js";
import { composeDirectives } from "../src/explain/engine.js";
import { knowledge, makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

const CONTRACT: EngineContract = {
  contract_version: "open_world_v4",
  tools: [],
  event_types: [],
  artifact_url_base: "/api/v1/media",
};

/** mock 引擎：返回一段 SSE 流（session → done ok） */
function mockEngineFetch(opts: { status?: string; videoUrl?: string | null; doneText?: string; delayMs?: number }): typeof fetch {
  return (async (_url: unknown, _init?: unknown) => {
    const lines = [
      "event: session",
      'data: {"session_id": "mock-session-1"}',
      "",
      "event: done",
      `data: ${JSON.stringify({
        status: opts.status ?? "ok",
        text: opts.doneText ?? "答案：X。视频已生成。",
        final_video_url: opts.videoUrl === null ? null : (opts.videoUrl ?? "/api/v1/media/videos/mock/720p30/S.mp4"),
      })}`,
      "",
    ].join("\n");
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return new Response(lines, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

function makeExplainApp(engineFetch: typeof fetch | undefined, contract: EngineContract | null = CONTRACT) {
  const env = tempFixtureEnv([
    makeQuestion({ id: "eq1", nodeIds: [NODE_A], stem: "讲解题", answer: "26", analysis: "解析文本" }),
  ]);
  env.state.contract = contract;
  env.state.engineFetch = engineFetch;
  return { app: createApp(env.state), ...env };
}

async function post(app: ReturnType<typeof makeExplainApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function waitJob(app: ReturnType<typeof makeExplainApp>["app"], jobId: string) {
  for (let i = 0; i < 50; i++) {
    const res = await app.request(`/api/v1/explain/jobs/${jobId}`);
    const body = await res.json();
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job never settled");
}

describe("composeDirectives", () => {
  it("injects misconception into directives", () => {
    const node = knowledge.graph.nodes.find((n) => n.misconceptions.length > 0)!;
    const directives = composeDirectives({
      knowledge,
      focusNodeId: node.id,
      misconceptionId: node.misconceptions[0]!.id,
    });
    expect(directives).toContain("误概念");
    expect(directives).toContain(node.misconceptions[0]!.desc.slice(0, 6));
  });
});

describe("explain pipeline", () => {
  it("generates via engine, registers explanation, then serves from cache", async () => {
    const { app, repo } = makeExplainApp(mockEngineFetch({ doneText: "视频已生成" }));
    const first = await post(app, "/api/v1/explain", { questionId: "eq1" });
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("generating");
    expect(first.body.fallback.analysis).toBe("解析文本");

    const job = await waitJob(app, first.body.jobId);
    expect(job.status).toBe("done");
    expect(job.explanation.videoUrl).toContain("/api/v1/media/");
    expect(job.explanation.quality).toBe("good");

    const second = await post(app, "/api/v1/explain", { questionId: "eq1" });
    expect(second.body.status).toBe("ready");
    expect(second.body.explanation.videoUrl).toBe(job.explanation.videoUrl);
    expect(repo.findExplanation("eq1", undefined)?.engineSessionId).toBe("mock-session-1");
  });

  it("degraded-delivery done text maps quality to acceptable", async () => {
    const { app } = makeExplainApp(mockEngineFetch({ doneText: "当前为可播放保底版本，质量提示请查看 Watch 阶段。" }));
    const first = await post(app, "/api/v1/explain", { questionId: "eq1" });
    const job = await waitJob(app, first.body.jobId);
    expect(job.explanation.quality).toBe("acceptable");
  });

  it("engine failure fails the job; fallback was already delivered", async () => {
    const { app } = makeExplainApp(mockEngineFetch({ status: "failed", videoUrl: null, doneText: "门禁未过" }));
    const first = await post(app, "/api/v1/explain", { questionId: "eq1" });
    expect(first.body.fallback.rootNode?.name).toBeTruthy();
    const job = await waitJob(app, first.body.jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("门禁");
  });

  it("engine offline returns fallback-only honestly", async () => {
    const { app } = makeExplainApp(undefined, null);
    const res = await post(app, "/api/v1/explain", { questionId: "eq1" });
    expect(res.body.status).toBe("offline");
    expect(res.body.fallback.rootNode?.name).toBeTruthy();
  });

  it("dedupes concurrent jobs for the same question", async () => {
    const { app } = makeExplainApp(mockEngineFetch({ delayMs: 200 }));
    const first = await post(app, "/api/v1/explain", { questionId: "eq1" });
    const second = await post(app, "/api/v1/explain", { questionId: "eq1" });
    expect(second.body.status).toBe("generating");
    expect(second.body.jobId).toBe(first.body.jobId);
  });

  it("focus-node-only request works without a question", async () => {
    const { app } = makeExplainApp(mockEngineFetch({}));
    const first = await post(app, "/api/v1/explain", { focusNodeId: NODE_A });
    expect(first.body.status).toBe("generating");
    const job = await waitJob(app, first.body.jobId);
    expect(job.status).toBe("done");
    expect(job.explanation.focusNodeIds).toEqual([NODE_A]);
  });
});
