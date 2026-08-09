import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetKnowledgeCache } from "../src/atlas.js";
import { loadConfig } from "../src/config.js";

function makeApp(contract: Parameters<typeof createApp>[0]["contract"] = null) {
  resetKnowledgeCache();
  const config = loadConfig({ ...process.env });
  return createApp({ config, contract });
}

describe("server app", () => {
  it("healthz reports engine offline without contract", async () => {
    const app = makeApp(null);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.engine).toBe("offline");
  });

  it("registry returns 503 when engine offline", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/v1/registry");
    expect(res.status).toBe(503);
  });

  it("atlas serves the real knowledge graph (75 nodes, 40 problem types)", async () => {
    const app = makeApp(null);
    const res = await app.request("/api/v1/atlas");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.graph.nodes.length).toBe(75);
    expect(body.problemTypes.length).toBe(40);
    expect(body.mastery).toEqual({});
  });
});
