import { describe, expect, it } from "vitest";
import { makeApp, makeQuestion } from "./helpers.js";

describe("server app", () => {
  it("healthz reports engine offline and question/learner counts", async () => {
    const { app } = makeApp([makeQuestion({ id: "q1" })]);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.engine).toBe("offline");
    expect(body.questions).toBe(1);
  });

  it("registry returns 503 when engine offline", async () => {
    const { app } = makeApp([]);
    const res = await app.request("/api/v1/registry");
    expect(res.status).toBe(503);
  });

  it("atlas serves the real knowledge graph (四个学段齐全，题型 40)", async () => {
    const { app } = makeApp([]);
    const res = await app.request("/api/v1/atlas");
    expect(res.status).toBe(200);
    const body = await res.json();
    // 规模会随课标补全增长，断言下限与学段齐全而不是具体数字
    expect(body.graph.nodes.length).toBeGreaterThanOrEqual(120);
    expect(new Set(body.graph.nodes.map((n: { stage: string }) => n.stage)).size).toBe(4);
    expect(body.problemTypes.length).toBe(40);
    expect(body.mastery).toEqual({});
  });
});
