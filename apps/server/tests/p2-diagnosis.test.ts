import { describe, expect, it } from "vitest";
import { buildChain, diagnoseMistake, backfillProbeEvidence } from "../src/diagnosis.js";
import { getVariant } from "../src/variant.js";
import { knowledge, makeApp, makeQuestion, NODE_A } from "./helpers.js";

/** 找一个有前置链的节点做 fixture：node -> prereq */
const nodeWithPrereq = knowledge.graph.nodes.find((n) => n.prerequisites.length > 0)!;
const PREREQ = nodeWithPrereq.prerequisites[0]!;
const CHILD = nodeWithPrereq.id;

async function post(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("buildChain", () => {
  it("reconstructs prerequisite chain from question node to root", () => {
    const chain = buildChain(knowledge, [CHILD], PREREQ);
    expect(chain[0]).toBe(PREREQ);
    expect(chain[chain.length - 1]).toBe(CHILD);
  });
});

describe("diagnoseMistake", () => {
  function setup() {
    const env = makeApp([
      makeQuestion({ id: "dq1", nodeIds: [CHILD], stem: "错题", answer: "10" }),
      makeQuestion({ id: "probe1", nodeIds: [PREREQ], stem: "前置探针题", answer: "5", difficulty: 1 }),
    ]);
    const learner = env.repo.createLearner("诊断生", "elementary_upper");
    return { ...env, learner };
  }

  it("deterministic fallback picks weakest prerequisite, queues probe, persists mistake", async () => {
    const { repo, store, learner } = setup();
    // 前置节点有低掌握度证据 → 承重归因 eligible
    repo.upsertMastery({ learnerId: learner.id, nodeId: PREREQ, p: 0.15, evidenceN: 3, lastEvidenceAt: new Date().toISOString() });
    const attempt = repo.insertAttempt({
      learnerId: learner.id, questionId: "dq1", answer: "8",
      correct: false, hintLevelUsed: 3, source: "daily", needsReview: false,
    });
    const result = await diagnoseMistake({ knowledge, questions: store, repo, llm: null, attemptId: attempt.id });
    if ("error" in result) throw new Error(result.error);
    expect(result.rootNodeId).toBe(PREREQ);
    expect(result.eligible).toBe(true);
    expect(result.chain[0]).toBe(PREREQ);
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.probesQueued).toContain("probe1");
    expect(repo.getMistake(result.mistakeId)?.rootNodeId).toBe(PREREQ);
    // 队列里有探针（6h 后到期）
    const due = repo.dueQueueQuestionIds(learner.id, 10);
    expect(due.length).toBe(0); // 还没到期
  });

  it("ineligible when no candidate is verified or evidenced — locates but flags", async () => {
    const { repo, store, learner } = setup();
    const attempt = repo.insertAttempt({
      learnerId: learner.id, questionId: "dq1", answer: "8",
      correct: false, hintLevelUsed: 0, source: "daily", needsReview: false,
    });
    const result = await diagnoseMistake({ knowledge, questions: store, repo, llm: null, attemptId: attempt.id });
    if ("error" in result) throw new Error(result.error);
    // 图谱节点全是 ai-generated 且无证据 → 不承重
    expect(result.eligible).toBe(false);
    expect(result.explanation).toContain("探针");
  });

  it("LLM restricted selection: hallucinated ids are rejected by program validation", async () => {
    const { repo, store, learner } = setup();
    repo.upsertMastery({ learnerId: learner.id, nodeId: PREREQ, p: 0.1, evidenceN: 2, lastEvidenceAt: new Date().toISOString() });
    const attempt = repo.insertAttempt({
      learnerId: learner.id, questionId: "dq1", answer: "8",
      correct: false, hintLevelUsed: 3, source: "daily", needsReview: false,
    });
    const lyingLlm = { generate: async () => '{"rootNodeId":"totally-fake-node","misconceptionId":"fake","surface":"concept","explanation":"编的"}' };
    const result = await diagnoseMistake({ knowledge, questions: store, repo, llm: lyingLlm, attemptId: attempt.id });
    if ("error" in result) throw new Error(result.error);
    expect(result.rootNodeId).toBe(PREREQ); // 幻觉 id 被拒，回退确定性首选
    expect(result.misconceptionId === undefined || result.misconceptionId.startsWith(result.rootNodeId)).toBe(true);
  });

  it("probe backfill: wrong probe raises confidence and flips eligible", async () => {
    const { repo, store, learner } = setup();
    const attempt = repo.insertAttempt({
      learnerId: learner.id, questionId: "dq1", answer: "8",
      correct: false, hintLevelUsed: 0, source: "daily", needsReview: false,
    });
    const diag = await diagnoseMistake({ knowledge, questions: store, repo, llm: null, attemptId: attempt.id });
    if ("error" in diag) throw new Error(diag.error);
    const before = repo.getMistake(diag.mistakeId)!;
    expect(before.eligible).toBe(false);

    const probeQ = store.byId.get("probe1")!;
    const updated = backfillProbeEvidence(repo, learner.id, probeQ, false);
    expect(updated).toBeGreaterThan(0);
    const after = repo.getMistake(diag.mistakeId)!;
    expect(after.confidence).toBeGreaterThan(before.confidence);
    expect(after.eligible).toBe(true); // 探针作答即实证（替代证据通道）

    // 探针做对 → 反证，置信度下调
    backfillProbeEvidence(repo, learner.id, probeQ, true);
    expect(repo.getMistake(diag.mistakeId)!.confidence).toBeLessThan(after.confidence);
  });
});

describe("getVariant supply chain", () => {
  it("prefers variantOf group from bank", async () => {
    const env = makeApp([
      makeQuestion({ id: "v1", nodeIds: [NODE_A], stem: "基题", answer: "1" }),
      makeQuestion({ id: "v2", nodeIds: [NODE_A], stem: "变式", answer: "2", variantOf: "v1" }),
    ]);
    const learner = env.repo.createLearner("变式生", "elementary_upper");
    const result = await getVariant({
      store: env.store, repo: env.repo, llm: null, dataDir: env.dataDir,
      learnerId: learner.id, questionId: "v1",
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.kind).toBe("bank");
    if (result.kind !== "none") expect(result.question.id).toBe("v2");
  });

  it("generates via LLM when bank empty; generated question lands in store as extracted", async () => {
    const env = makeApp([makeQuestion({ id: "solo", nodeIds: [NODE_A], stem: "孤题：3+4=?", answer: "7" })]);
    const learner = env.repo.createLearner("生成生", "elementary_upper");
    const genLlm = { generate: async () => '{"stem":"小狗有 5 根骨头，又得到 4 根，现在有几根？","answer":"9"}' };
    const result = await getVariant({
      store: env.store, repo: env.repo, llm: genLlm, dataDir: env.dataDir,
      learnerId: learner.id, questionId: "solo",
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.kind).toBe("generated");
    if (result.kind !== "none") {
      expect(result.question.variantOf).toBe("solo");
      const stored = env.store.byId.get(result.question.id)!;
      expect(stored.status).toBe("extracted"); // 进家长抽检
      expect(stored.source.role).toBe("generated");
    }
  });

  it("degrades to review queue when nothing available", async () => {
    const env = makeApp([makeQuestion({ id: "only", nodeIds: [NODE_A], stem: "唯一题", answer: "1" })]);
    const learner = env.repo.createLearner("降级生", "elementary_upper");
    const result = await getVariant({
      store: env.store, repo: env.repo, llm: null, dataDir: env.dataDir,
      learnerId: learner.id, questionId: "only",
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.kind).toBe("none");
  });
});

describe("diagnosis routes", () => {
  it("POST /diagnosis/:attemptId + GET /diagnosis/mistakes round-trip", async () => {
    const { app, repo } = makeApp([
      makeQuestion({ id: "rq1", nodeIds: [CHILD], stem: "路由错题", answer: "3" }),
    ]);
    const learner = repo.createLearner("路由生", "elementary_upper");
    const attempt = repo.insertAttempt({
      learnerId: learner.id, questionId: "rq1", answer: "9",
      correct: false, hintLevelUsed: 3, source: "daily", needsReview: false,
    });
    const diag = await post(app, `/api/v1/diagnosis/${attempt.id}`, {});
    expect(diag.status).toBe(200);
    expect(diag.body.rootNodeName).toBeTruthy();
    expect(Array.isArray(diag.body.chainNames)).toBe(true);
    expect(typeof diag.body.confidence).toBe("number");

    const list = await app.request(`/api/v1/diagnosis/mistakes?learnerId=${learner.id}`);
    const listBody = await list.json();
    expect(listBody.mistakes.length).toBe(1);
    expect(listBody.mistakes[0].questionStem).toBe("路由错题");
  });
});
