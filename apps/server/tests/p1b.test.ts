import { describe, expect, it } from "vitest";
import { offlineTextDrafts } from "../src/ingest/extraction.js";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkByQuestions, pairDrafts, stemSimilarity, guessRole } from "../src/ingest/batch.js";
import { buildCoverage, verifyNode, reviewQuestion } from "../src/knowledgeAdmin.js";
import { createQuestionStore } from "../src/questions.js";
import { loadKnowledge } from "@mathtutor/knowledge";
import { knowledge, makeApp, makeQuestion, NODE_A } from "./helpers.js";

const REAL_KNOWLEDGE_DIR = fileURLToPath(new URL("../../../data/knowledge", import.meta.url));

function tempDataDirWithKnowledge(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), "mathtutor-p1b-"));
  cpSync(REAL_KNOWLEDGE_DIR, path.join(dataDir, "knowledge"), { recursive: true });
  return dataDir;
}

describe("chunkByQuestions", () => {
  it("splits on question numbers and respects max size", () => {
    const text = Array.from({ length: 10 }, (_, i) => `${i + 1}. 这是第 ${i + 1} 道题的题干，${"内容".repeat(100)}`).join("\n");
    const chunks = chunkByQuestions(text, 1200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1200);
  });
  it("hard-splits pathological unnumbered text", () => {
    const chunks = chunkByQuestions("字".repeat(6000), 2600);
    expect(chunks.length).toBe(3);
  });

  it("chunk → offline re-segmentation round-trips question count (回归：题号补回)", async () => {
    const text = "1. 果园里有 45 棵苹果树，梨树比苹果树少 18 棵，梨树有多少棵？\n2. 一本书 96 页，小芳每天看 8 页，几天能看完？";
    const chunks = chunkByQuestions(text);
    expect(chunks.length).toBe(1);
    const drafts = offlineTextDrafts(chunks[0]!, "elementary_upper");
    expect(drafts.length).toBe(2);
  });

  it("offline drafts parse inline teacher answers/analysis (答案：/解析：)", async () => {
    const drafts = offlineTextDrafts(
      "1. 果园里有 45 棵苹果树，梨树比苹果树少 18 棵，梨树有多少棵？ 答案：27 棵。解析：45-18=27。",
      "elementary_upper",
    );
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.answer).toBe("27 棵");
    expect(drafts[0]!.analysis).toBe("45-18=27。");
    expect(drafts[0]!.stem).not.toContain("答案");
    expect(drafts[0]!.stem).toContain("梨树有多少棵");
  });
});

describe("teacher/student pairing", () => {
  const student = [
    { stem: "小明有 5 个苹果，吃了 2 个，还剩几个？", answer: "", answerType: "numeric" as const, difficulty: 2, level: "elementary_upper" as const },
    { stem: "一根绳子长 24 米，剪成 3 段，每段几米？", answer: "", answerType: "numeric" as const, difficulty: 2, level: "elementary_upper" as const },
  ];
  const teacher = [
    { stem: "小明有5个苹果，吃了2个，还剩几个？", answer: "3", analysis: "5-2=3", answerType: "numeric" as const, difficulty: 2, level: "elementary_upper" as const },
    { stem: "完全无关的另一道题：计算 7×8", answer: "56", answerType: "numeric" as const, difficulty: 1, level: "elementary_upper" as const },
  ];

  it("similarity is high for same stem with whitespace/fullwidth diffs", () => {
    expect(stemSimilarity(student[0]!.stem, teacher[0]!.stem)).toBeGreaterThan(0.9);
    expect(stemSimilarity(student[0]!.stem, teacher[1]!.stem)).toBeLessThan(0.3);
  });

  it("pairs student stems with teacher answers; keeps unmatched from both sides", () => {
    const { drafts, report } = pairDrafts(student, teacher);
    expect(report).toEqual({ matched: 1, teacherOnly: 1, studentOnly: 1 });
    const paired = drafts.find((d) => d.stem === student[0]!.stem)!;
    expect(paired.answer).toBe("3");
    expect(paired.analysis).toBe("5-2=3");
    // 学生版没配上的保留（无答案待人工），教师版独有的也保留（有答案）
    expect(drafts.some((d) => d.stem.includes("绳子") && d.answer === "")).toBe(true);
    expect(drafts.some((d) => d.stem.includes("7×8") && d.answer === "56")).toBe(true);
  });

  it("guesses role from filename", () => {
    expect(guessRole("第4讲 和差倍综合（教师版）.pdf")).toBe("teacher");
    expect(guessRole("第4讲 和差倍综合（学生版）.pdf")).toBe("student");
  });
});

describe("batch job flow through app", () => {
  it("text batch with teacher/student pairing runs to done and drafts carry locator suggestions", async () => {
    const { app } = makeApp([]);
    const res = await app.request("/api/v1/ingest/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batchName: "batch-test",
        files: [
          { name: "讲义（学生版）.txt", kind: "text", role: "auto", content: "1. 长方形长 8 厘米宽 5 厘米，周长多少？\n2. 鸡兔同笼共 8 头 22 脚，鸡兔各几只？" },
          { name: "讲义（教师版）.txt", kind: "text", role: "auto", content: "1. 长方形长 8 厘米宽 5 厘米，周长多少？ 答案：26 厘米\n2. 鸡兔同笼共 8 头 22 脚，鸡兔各几只？ 答案：鸡5兔3" },
        ],
      }),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();

    let job: { status: string; result?: { drafts?: unknown[]; pairing?: unknown } } = { status: "running" };
    for (let i = 0; i < 50 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = await (await app.request(`/api/v1/ingest/jobs/${jobId}`)).json();
    }
    expect(job.status).toBe("done");
    const result = job.result as { drafts: { suggestedNodeIds: string[] }[]; pairing: { matched: number } };
    expect(result.drafts.length).toBeGreaterThan(0);
    expect(result.pairing.matched).toBeGreaterThanOrEqual(1);
    expect(result.drafts.every((d) => Array.isArray(d.suggestedNodeIds))).toBe(true);
  });
});

describe("coverage report", () => {
  it("counts per node, lists gaps, surfaces top-unverified", () => {
    const dataDir = tempDataDirWithKnowledge();
    const kn = loadKnowledge({
      graphPath: path.join(dataDir, "knowledge", "graph.json"),
      problemsPath: path.join(dataDir, "knowledge", "problems.json"),
    });
    const store = createQuestionStore(dataDir, kn.index);
    const coverage = buildCoverage(kn, store);
    const graphNodes = kn.graph.nodes.length;
    expect(coverage.totals.nodes).toBe(graphNodes);
    expect(coverage.totals.questions).toBeGreaterThan(0); // seed-demo 已在真实 data 里
    expect(coverage.topUnverified.length).toBeGreaterThan(0);
    const uncovered = Object.values(coverage.uncoveredByStage).flat();
    expect(uncovered.length).toBeGreaterThan(0);
    expect(coverage.totals.covered + uncovered.length).toBe(graphNodes);
  });
});

describe("verify-node (file-first + lint gate)", () => {
  it("marks a node verified in graph.json and reloads", () => {
    const dataDir = tempDataDirWithKnowledge();
    const result = verifyNode(dataDir, NODE_A, { title: "人教版教材核对" });
    expect(result.ok).toBe(true);
    const raw = JSON.parse(readFileSync(path.join(dataDir, "knowledge", "graph.json"), "utf8"));
    const node = raw.nodes.find((n: { id: string }) => n.id === NODE_A);
    expect(node.status).toBe("verified");
    expect(node.sources.some((s: { title: string }) => s.title === "人教版教材核对")).toBe(true);
    if (result.ok) expect(result.knowledge.index.getNode(NODE_A)?.status).toBe("verified");
  });

  it("rejects unknown node", () => {
    const dataDir = tempDataDirWithKnowledge();
    const result = verifyNode(dataDir, "no-such-node");
    expect(result.ok).toBe(false);
  });
});

describe("question review (抽检裁决)", () => {
  it("verified with patch edits the batch file; rejected removes", () => {
    const dataDir = tempDataDirWithKnowledge();
    const kn = loadKnowledge({
      graphPath: path.join(dataDir, "knowledge", "graph.json"),
      problemsPath: path.join(dataDir, "knowledge", "problems.json"),
    });
    const store = createQuestionStore(dataDir, kn.index);
    const before = store.all.length;
    const target = store.all.find((q) => q.status === "verified") ?? store.all[0]!;

    const ok = reviewQuestion(dataDir, target.id, "verified", { answer: "42" });
    expect(ok.ok).toBe(true);
    store.reload();
    expect(store.byId.get(target.id)?.answer).toBe("42");
    expect(store.byId.get(target.id)?.status).toBe("verified");

    const removed = reviewQuestion(dataDir, target.id, "rejected");
    expect(removed.ok).toBe(true);
    store.reload();
    expect(store.all.length).toBe(before - 1);
    expect(store.byId.has(target.id)).toBe(false);
  });

  it("unknown question id fails cleanly", () => {
    const dataDir = tempDataDirWithKnowledge();
    expect(reviewQuestion(dataDir, "nope", "rejected").ok).toBe(false);
  });
});

describe("review endpoint wiring", () => {
  it("rejects dangling nodeIds in patch", async () => {
    const { app } = makeApp([makeQuestion({ id: "rw1" })]);
    const res = await app.request("/api/v1/ingest/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: "rw1", verdict: "verified", patch: { nodeIds: ["ghost-node"] } }),
    });
    expect(res.status).toBe(422);
  });

  it("questions listing exposes answers for parent review", async () => {
    const { app } = makeApp([makeQuestion({ id: "rw2", answer: "88" })]);
    const res = await app.request("/api/v1/ingest/questions?limit=10");
    const body = await res.json();
    expect(body.items.some((q: { id: string; answer: string }) => q.id === "rw2" && q.answer === "88")).toBe(true);
  });
});
