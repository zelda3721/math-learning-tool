import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadKnowledge } from "../src/load.js";
import { lint } from "../src/lint.js";
import { matchOffline, matchProblemTypesOffline, problemsForNode } from "../src/locator.js";

const knowledge = loadKnowledge({
  graphPath: fileURLToPath(new URL("../../../data/knowledge/graph.json", import.meta.url)),
  problemsPath: fileURLToPath(new URL("../../../data/knowledge/problems.json", import.meta.url)),
});

describe("lint invariants on real data", () => {
  it("passes with zero errors", () => {
    const report = lint(knowledge.graph, knowledge.problemTypes);
    expect(report.errors).toEqual([]);
    expect(report.stats.nodes).toBe(75);
    expect(report.stats.problems).toBe(40);
  });
});

describe("graph traversals", () => {
  it("evolutionPath from a primary node reaches university", () => {
    const primary = knowledge.graph.nodes.find((n) => n.stage === "primary")!;
    const path = knowledge.index.evolutionPath(primary.id);
    expect(path.length).toBeGreaterThan(0);
    const last = path[path.length - 1]!;
    expect(knowledge.index.getNode(last.to)?.stage).toBe("university");
  });

  it("traceRootCandidates surfaces weak prerequisites", () => {
    const withPrereq = knowledge.graph.nodes.find((n) => n.prerequisites.length > 0)!;
    const weakId = withPrereq.prerequisites[0]!;
    const candidates = knowledge.index.traceRootCandidates([withPrereq.id], (nodeId) =>
      nodeId === weakId ? { p: 0.1, evidenceN: 5 } : { p: 0.9, evidenceN: 5 },
    );
    expect(candidates.some((c) => c.nodeId === weakId && c.reason === "low-mastery")).toBe(true);
    expect(candidates.every((c) => c.nodeId !== withPrereq.id)).toBe(true);
  });

  it("nodes with no evidence become no-evidence candidates", () => {
    const withPrereq = knowledge.graph.nodes.find((n) => n.prerequisites.length > 0)!;
    const candidates = knowledge.index.traceRootCandidates([withPrereq.id], () => undefined);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.reason === "no-evidence")).toBe(true);
  });
});

describe("offline locator", () => {
  it("locates 鸡兔同笼 problem type from a word problem", () => {
    const text = "鸡兔同笼，共有 35 个头，94 只脚，鸡和兔各有多少只？";
    const matches = matchProblemTypesOffline(knowledge.problemTypes, text);
    expect(matches.length).toBeGreaterThan(0);
    const names = matches.map((m) => knowledge.problemTypes.find((p) => p.id === m.id)?.name);
    expect(names.join()).toContain("鸡兔同笼");
  });

  it("locates knowledge nodes for a fraction question", () => {
    const matches = matchOffline(knowledge.index, "把一个西瓜平均分成 8 份，小明吃了其中 3 份，吃了几分之几？");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("problemsForNode reverse index is consistent", () => {
    const pt = knowledge.problemTypes.find((p) => p.nodes.length > 0)!;
    const nodeId = pt.nodes[0]!;
    const back = problemsForNode(knowledge.problemTypes, nodeId);
    expect(back.some((p) => p.id === pt.id)).toBe(true);
  });
});
