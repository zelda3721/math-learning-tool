import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { GraphSchema, ProblemTypesSchema } from "../src/index.js";

const graphRaw = JSON.parse(
  readFileSync(new URL("../../../data/knowledge/graph.json", import.meta.url), "utf8"),
);
const problemsRaw = JSON.parse(
  readFileSync(new URL("../../../data/knowledge/problems.json", import.meta.url), "utf8"),
);

describe("schema parses real knowledge data", () => {
  it("parses graph.json（四个学段齐全，规模不倒退）", () => {
    const graph = GraphSchema.parse(graphRaw);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(120);
    expect(graph.stages.length).toBe(4);
    expect(graph.strands.length).toBe(4);
  });

  it("normalizes legacy string misconceptions into objects", () => {
    const graph = GraphSchema.parse(graphRaw);
    for (const node of graph.nodes) {
      for (const m of node.misconceptions) {
        expect(typeof m).toBe("object");
        expect(m.id).toBeTruthy();
        expect(m.desc).toBeTruthy();
        expect(Array.isArray(m.signals)).toBe(true);
      }
    }
    const withMisc = graph.nodes.filter((n) => n.misconceptions.length > 0);
    expect(withMisc.length).toBe(75);
  });

  it("parses problems.json with 40 problem types and upgrades evolveNote to unifiedBy", () => {
    const types = ProblemTypesSchema.parse(problemsRaw);
    expect(types.length).toBe(40);
    const unified = types.filter((t) => t.unifiedBy !== undefined);
    expect(unified.length).toBe(19);
    for (const t of unified) {
      expect(t.unifiedBy?.note).toBeTruthy();
    }
    for (const t of types) {
      expect(t).not.toHaveProperty("evolveNote");
    }
  });
});
