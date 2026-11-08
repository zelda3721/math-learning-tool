import { describe, expect, it } from "vitest";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { masteryBand, litByEvidence, type EvidenceStats } from "../src/mastery.js";
import { evidenceStatsByNode, nodeEvidenceCounts, type EvidenceAttempt } from "../src/evidence.js";
import { looksLikeGiveUp } from "../src/routes/practice.js";
import { knowledge, makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

/**
 * P0 修正的回归：堵住依赖通道、让"点亮"名副其实。
 *
 * 这些测试都是**经过 HTTP** 的（除了纯函数那几条）：验收要能被别人复核，
 * 而"服务端到底拦没拦"只有真请求才说得清。
 */

function client(app: ReturnType<typeof createApp>) {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
  };
}

/** 带账户体系的环境：孩子会话、家长会话都能测 */
function makeAuthEnv(questions: ReturnType<typeof makeQuestion>[]) {
  const env = tempFixtureEnv(questions);
  const db = openMemoryDb();
  const repo = new Repo(db);
  const state: AppState = { ...env.state, repo, auth: new AuthStore(db), authDisabled: false };
  return { ...env, repo, state, app: createApp(state) };
}

async function setupParentAndChild(env: ReturnType<typeof makeAuthEnv>) {
  const parent = client(env.app);
  await parent.call("POST", "/api/v1/auth/setup-parent", { username: "爸爸", password: "family-secret" });
  const child = client(env.app);
  const reg = await child.call("POST", "/api/v1/auth/register-child", {
    username: "小明",
    password: "child-secret",
    level: "elementary_upper",
  });
  const learnerId = env.repo.listLearners()[0]!.id;
  return { parent, child, learnerId, reg };
}

describe("P0-1 讲解入口：孩子走过一遍才给看", () => {
  it("没有作答过 → 403；三级提示用完并且交过答案 → 给讲（带解析）", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "eq1", answer: "7", analysis: "先求每份，再乘 3，答案是 7" })]);
    const { child, learnerId } = await setupParentAndChild(env);

    const early = await child.call("POST", "/api/v1/explain", { questionId: "eq1", learnerId });
    expect(early.status).toBe(403);
    expect(early.body.code).toBe("explain-locked");
    expect(JSON.stringify(early.body)).not.toContain("答案是 7");

    // 服务端记账：提示要一级一级来
    const skip = await child.call("POST", "/api/v1/practice/hint", { questionId: "eq1", level: 3, learnerId });
    expect(skip.status).toBe(409);
    for (const level of [1, 2, 3]) {
      const res = await child.call("POST", "/api/v1/practice/hint", { questionId: "eq1", level, learnerId });
      expect(res.status).toBe(200);
    }

    // 光点三下提示、一个字不写，还不算走过一遍（A-05）
    const hintsOnly = await child.call("POST", "/api/v1/explain", { questionId: "eq1", learnerId });
    expect(hintsOnly.status).toBe(403);

    const wrong = await child.call("POST", "/api/v1/practice/submit", { questionId: "eq1", answer: "3", learnerId });
    expect(wrong.body.correct).toBe(false);
    const after = await child.call("POST", "/api/v1/explain", { questionId: "eq1", learnerId });
    expect(after.status).toBe(200);
    expect(after.body.fallback?.analysis).toContain("答案是 7");
  });

  it("家长不受这条闸管（家长本来就要能核对讲解）", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "eq2", answer: "5", analysis: "解析在家长这边照常给" })]);
    const parent = client(env.app);
    await parent.call("POST", "/api/v1/auth/setup-parent", { username: "妈妈", password: "family-secret" });
    const res = await parent.call("POST", "/api/v1/explain", { questionId: "eq2" });
    expect(res.status).toBe(200);
    expect(res.body.fallback?.analysis).toContain("解析在家长这边照常给");
  });
});

describe("P0-1 问一道题：家长能关，时长闸也管", () => {
  it("模块被关掉 → 403 且话是给孩子看的", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" })]);
    const { child, learnerId } = await setupParentAndChild(env);
    env.repo.setLearnerPrefs(learnerId, { modules: { ask: false } });
    const res = await child.call("POST", "/api/v1/ask", { problem: "小明有 26 个苹果，吃掉了 3 个，还剩几个？" });
    expect(res.status).toBe(403);
    expect(res.body.module).toBe("ask");
    expect(res.body.error).toContain("家长");
  });

  it("今天时间用完 → 429，不给模型送题", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" })]);
    const { child, learnerId } = await setupParentAndChild(env);
    env.repo.appendEvent(learnerId, "active-usage", { seconds: 3600 });
    const res = await child.call("POST", "/api/v1/ask", { problem: "小明有 26 个苹果，吃掉了 3 个，还剩几个？" });
    expect(res.status).toBe(429);
    expect(String(res.body.error)).toContain("时间用完");
  });
});

describe("P0-2 乱打字不再等于跳题", () => {
  it("「不会」不算一次作答，题留在原地；随后答对仍然计分", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" })]);
    const { child, learnerId } = await setupParentAndChild(env);

    const giveUp = await child.call("POST", "/api/v1/practice/submit", { answer: "不会", questionId: "q1", learnerId });
    expect(giveUp.status).toBe(200);
    expect(giveUp.body.notAnAnswer).toBe(true);
    expect(giveUp.body.needsReview).toBe(false);
    expect(giveUp.body.countedTowardMastery).toBe(false);

    const real = await child.call("POST", "/api/v1/practice/submit", { answer: "26", questionId: "q1", learnerId });
    expect(real.body.correct).toBe(true);
    expect(real.body.countedTowardMastery).toBe(true);
    expect(real.body.mastery.length).toBeGreaterThan(0);
  });

  it("looksLikeGiveUp 只认真正的放弃话术，不误伤答案", () => {
    expect(looksLikeGiveUp("不会")).toBe(true);
    expect(looksLikeGiveUp("  不知道。 ")).toBe(true);
    expect(looksLikeGiveUp("？？？")).toBe(true);
    expect(looksLikeGiveUp("26")).toBe(false);
    expect(looksLikeGiveUp("3/4")).toBe(false);
    expect(looksLikeGiveUp("x = 5")).toBe(false);
  });
});

describe("P0-3 点亮要独立证据", () => {
  it("同一道题同一天重交不再刷成新证据", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" })]);
    const { child, learnerId } = await setupParentAndChild(env);
    const first = await child.call("POST", "/api/v1/practice/submit", { answer: "26", questionId: "q1", learnerId });
    expect(first.body.countedTowardMastery).toBe(true);
    const second = await child.call("POST", "/api/v1/practice/submit", { answer: "26", questionId: "q1", learnerId });
    expect(second.body.repeat).toBe(true);
    expect(second.body.countedTowardMastery).toBe(false);
    expect(second.body.mastery.length).toBe(0);
  });

  it("连交两次错答案不再连续扣分（订正过程不再把星打回暗）", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" })]);
    const { child, learnerId } = await setupParentAndChild(env);
    const first = await child.call("POST", "/api/v1/practice/submit", { answer: "25", questionId: "q1", learnerId });
    expect(first.body.countedTowardMastery).toBe(true);
    const second = await child.call("POST", "/api/v1/practice/submit", { answer: "27", questionId: "q1", learnerId });
    expect(second.body.repeat).toBe(true);
    const row = env.repo.getMastery(learnerId, NODE_A)!
    expect(row.evidenceN).toBe(1);
  });

  it("同一道题重交三次也点不亮：独立证据要求不同题、隔天、未见题", () => {
    const questions = { byId: new Map([["a", { nodeIds: ["n1"] }]]) };
    const attempts: EvidenceAttempt[] = [0, 1, 2].map((i) => ({
      questionId: "a",
      correct: true,
      hintLevelUsed: 0 as const,
      at: `2026-11-07T0${i}:00:00.000Z`,
      source: "daily",
      verification: "executable",
      needsReview: false,
      actor: "child",
    }));
    const stats = evidenceStatsByNode(attempts, questions, new Map());
    const s = stats.get("n1")!;
    expect(s.counted).toBe(1);
    expect(s.independent).toBe(1);
    expect(s.distinctQuestions).toBe(1);
    expect(masteryBand(0.9, 3, s)).not.toBe("lit");
  });

  it("两道不同的未见题、隔天、零提示做对 → 点亮", () => {
    const questions = {
      byId: new Map([
        ["a", { nodeIds: ["n1"] }],
        ["b", { nodeIds: ["n1"] }],
      ]),
    };
    const base = { hintLevelUsed: 0 as const, source: "daily", verification: "executable", needsReview: false, actor: "child" };
    const attempts: EvidenceAttempt[] = [
      { ...base, questionId: "a", correct: true, at: "2026-11-07T09:00:00.000Z" },
      { ...base, questionId: "b", correct: true, at: "2026-11-08T09:00:00.000Z" },
      { ...base, questionId: "a", correct: false, at: "2026-11-08T10:00:00.000Z" },
    ];
    const s = evidenceStatsByNode(attempts, questions, new Map()).get("n1")!;
    expect(s.independent).toBe(2);
    expect(s.distinctQuestions).toBe(2);
    expect(s.spanDays).toBeGreaterThanOrEqual(1);
    expect(s.hasFirstSeen).toBe(true);
    // 阈值是 3 条独立证据：两条还不够
    expect(litByEvidence(s)).toBe(false);
    const third: EvidenceAttempt[] = [
      ...attempts,
      { ...base, questionId: "c", correct: true, at: "2026-11-09T09:00:00.000Z" },
    ];
    const questions3 = { byId: new Map([...questions.byId, ["c", { nodeIds: ["n1"] }]]) };
    const s3 = evidenceStatsByNode(third, questions3, new Map()).get("n1")!;
    expect(litByEvidence(s3)).toBe(true);
    expect(masteryBand(0.75, 4, s3)).toBe("lit");
  });

  it("看过解析之后再答对，不算独立证据", () => {
    const questions = { byId: new Map([["a", { nodeIds: ["n1"] }]]) };
    const attempts: EvidenceAttempt[] = [
      {
        questionId: "a",
        correct: true,
        hintLevelUsed: 0,
        at: "2026-11-07T09:00:00.000Z",
        source: "daily",
        verification: "executable",
        needsReview: false,
        actor: "child",
      },
    ];
    const views = new Map([["a", ["2026-11-07T08:00:00.000Z"]]]);
    const s = evidenceStatsByNode(attempts, questions, views).get("n1")!;
    expect(s.independent).toBe(0);
    expect(litByEvidence(s)).toBe(false);
  });

  it("家长试做不进证据", () => {
    const questions = { byId: new Map([["a", { nodeIds: ["n1"] }]]) };
    const attempts: EvidenceAttempt[] = [
      {
        questionId: "a",
        correct: true,
        hintLevelUsed: 0,
        at: "2026-11-07T09:00:00.000Z",
        source: "daily",
        verification: "executable",
        needsReview: false,
        actor: "parent",
      },
    ];
    expect(evidenceStatsByNode(attempts, questions, new Map()).get("n1")).toBeUndefined();
  });

  it("家长在孩子的页面上试做：不写掌握度，但留痕", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" })]);
    const { parent, learnerId } = await setupParentAndChild(env);
    const res = await parent.call("POST", "/api/v1/practice/submit", { learnerId, questionId: "q1", answer: "26" });
    expect(res.status).toBe(200);
    expect(res.body.trial).toBe(true);
    expect(res.body.countedTowardMastery).toBe(false);
    expect(env.repo.getMastery(learnerId, NODE_A)).toBeUndefined();
    expect(env.repo.attemptsForEvidence(learnerId).length).toBe(1);
  });
});

describe("P0-4 证据通道", () => {
  it("探针的来源按队列项判定：客户端说 daily 也算 probe，没有队列项则退回 daily", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "p1", answer: "5" }), makeQuestion({ id: "p2", answer: "6" })]);
    const { child, learnerId } = await setupParentAndChild(env);
    const queueId = env.repo.pushQueueItem(learnerId, "probe", "p1", new Date(Date.now() - 1000).toISOString());

    const withQueue = await child.call("POST", "/api/v1/practice/submit", {
      learnerId,
      questionId: "p1",
      answer: "5",
      source: "daily",
      queueItemId: queueId,
    });
    expect(env.repo.getAttempt(withQueue.body.attemptId)?.source).toBe("probe");

    const claimed = await child.call("POST", "/api/v1/practice/submit", {
      learnerId,
      questionId: "p2",
      answer: "6",
      source: "probe",
    });
    expect(env.repo.getAttempt(claimed.body.attemptId)?.source).toBe("daily");
  });

  it("归因不再自证：新孩子的根因不塌缩成题目自己那个节点", async () => {
    const nodeWithPrereq = knowledge.graph.nodes.find((n) => n.prerequisites.length > 0)!;
    const PREREQ = nodeWithPrereq.prerequisites[0]!;
    const CHILD = nodeWithPrereq.id;
    const env = makeAuthEnv([makeQuestion({ id: "dq1", nodeIds: [CHILD], answer: "10" })]);
    const { child, learnerId } = await setupParentAndChild(env);

    const wrong = await child.call("POST", "/api/v1/practice/submit", { questionId: "dq1", answer: "3", learnerId });
    expect(wrong.body.correct).toBe(false);
    // 归因和讲解同一道门：答错一次就直接调归因 → 403；三级提示走完才给
    const early = await child.call("POST", `/api/v1/diagnosis/${wrong.body.attemptId}`, {});
    expect(early.status).toBe(403);
    for (const level of [1, 2, 3]) {
      const res = await child.call("POST", "/api/v1/practice/hint", { questionId: "dq1", level, learnerId });
      expect(res.status).toBe(200);
    }
    const diag = await child.call("POST", `/api/v1/diagnosis/${wrong.body.attemptId}`, {});
    expect(diag.status).toBe(200);
    expect(diag.body.rootNodeId).toBe(PREREQ);
    expect(diag.body.eligible).toBe(false);
  });

  it("nodeEvidenceCounts 不把同题同日的重复作答算进去", () => {
    const questions = { byId: new Map([["a", { nodeIds: ["n1", "n2"] }]]) };
    const base = { correct: true, hintLevelUsed: 0, source: "daily", verification: "executable", needsReview: false, actor: "child" };
    const counts = nodeEvidenceCounts(
      [
        { ...base, questionId: "a", at: "2026-11-07T09:00:00.000Z" },
        { ...base, questionId: "a", at: "2026-11-07T10:00:00.000Z" },
        { ...base, questionId: "a", at: "2026-11-08T10:00:00.000Z" },
      ],
      questions,
    );
    expect(counts.get("n1")).toBe(2);
    expect(counts.get("n2")).toBe(2);
  });
});

/** 纯类型占用：EvidenceStats 是给调用方的公开形状 */
const _shape: EvidenceStats = { counted: 0, independent: 0, distinctQuestions: 0, spanDays: 0, hasFirstSeen: false };
void _shape;
