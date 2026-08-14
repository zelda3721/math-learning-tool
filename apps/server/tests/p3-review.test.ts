import { describe, expect, it } from "vitest";
import { REVIEW_PARAMS } from "@mathtutor/schema";
import { advanceReviewCard, ensureReviewCard, pickReviewQuestion } from "../src/review.js";
import { composeToday } from "../src/composer.js";
import { knowledge, makeApp, makeQuestion, NODE_A, NODE_B } from "./helpers.js";
// 静态导入：写在用例体内的 await import 在并发跑整套时会超时（见 figure-gate.test.ts）
import { createApp } from "../src/app.js";

async function post(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("SM-2 review cards", () => {
  it("wrong daily answer creates a card; correct advances stages to mastered; wrong regresses 2", async () => {
    const { app, repo } = makeApp([
      makeQuestion({ id: "r1", nodeIds: [NODE_A], stem: "复习基题", answer: "5" }),
      makeQuestion({ id: "r2", nodeIds: [NODE_A], stem: "复习变式", answer: "6", variantOf: "r1" }),
    ]);
    const learner = repo.createLearner("复习生", "elementary_upper");

    // 答错 → 自动建卡
    await post(app, "/api/v1/practice/submit", { learnerId: learner.id, questionId: "r1", answer: "99" });
    // 卡明天到期 → 手动把到期时间调到现在以模拟次日
    const card = repo.dueReviewCards(learner.id, 10);
    expect(card.length).toBe(0);
    // 直接经 repo 调整（模拟时间流逝）
    repo.upsertReviewCard(learner.id, "question", "r1", new Date(Date.now() - 1000).toISOString());
    const due = repo.dueReviewCards(learner.id, 10);
    expect(due.length).toBe(1);

    // 推进：连续答对走完全部间隔 → mastered
    let state = advanceReviewCard(repo, due[0]!.id, true);
    expect(state.stage).toBe(1);
    for (let i = 1; i < REVIEW_PARAMS.intervalsDays.length; i++) {
      state = advanceReviewCard(repo, due[0]!.id, true);
    }
    expect(state.mastered).toBe(true);

    // 新卡答错 → 回退 2 档
    repo.upsertReviewCard(learner.id, "question", "r2", new Date(Date.now() - 1000).toISOString());
    const card2 = repo.dueReviewCards(learner.id, 10)[0]!;
    advanceReviewCard(repo, card2.id, true);
    advanceReviewCard(repo, card2.id, true);
    advanceReviewCard(repo, card2.id, true); // stage 3
    const after = advanceReviewCard(repo, card2.id, false);
    expect(after.stage).toBe(1); // 3 - 2
    expect(repo.getReviewCard(card2.id)!.lapseCount).toBe(1);
  });

  it("pickReviewQuestion prefers variant group over original (换题再练)", () => {
    const { store, repo } = makeApp([
      makeQuestion({ id: "o1", nodeIds: [NODE_A], stem: "原题", answer: "1" }),
      makeQuestion({ id: "o2", nodeIds: [NODE_A], stem: "同组变式", answer: "2", variantOf: "o1" }),
    ]);
    const learner = repo.createLearner("换题生", "elementary_upper");
    repo.upsertReviewCard(learner.id, "question", "o1", new Date(Date.now() - 1000).toISOString());
    const card = repo.dueReviewCards(learner.id, 1)[0]!;
    const q = pickReviewQuestion(store, card, new Set());
    expect(q?.id).toBe("o2"); // 不出原题
  });

  it("composer puts due reviews first with reviewCardId", () => {
    const env = makeApp([
      makeQuestion({ id: "c1", nodeIds: [NODE_A], stem: "复习原题", answer: "1" }),
      makeQuestion({ id: "c2", nodeIds: [NODE_A], stem: "复习换题", answer: "2", variantOf: "c1" }),
      makeQuestion({ id: "c3", nodeIds: [NODE_B], stem: "新题", answer: "3" }),
    ]);
    const learner = env.repo.createLearner("组卷生", "elementary_upper");
    env.repo.upsertReviewCard(learner.id, "question", "c1", new Date(Date.now() - 1000).toISOString());
    const composed = composeToday(env.store, knowledge.index, env.repo, learner.id, { count: 3, challenge: false });
    expect(composed[0]!.slot).toBe("review");
    expect(composed[0]!.question.id).toBe("c2");
    expect(composed[0]!.reviewCardId).toBeTruthy();
  });

  it("submit with reviewCardId advances the card", async () => {
    const { app, repo } = makeApp([
      makeQuestion({ id: "s1", nodeIds: [NODE_A], stem: "推进题", answer: "8" }),
    ]);
    const learner = repo.createLearner("推进生", "elementary_upper");
    repo.upsertReviewCard(learner.id, "question", "s1", new Date(Date.now() - 1000).toISOString());
    const card = repo.dueReviewCards(learner.id, 1)[0]!;
    const res = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id, questionId: "s1", answer: "8", source: "review", reviewCardId: card.id,
    });
    expect(res.body.review.stage).toBe(1);
    expect(repo.getReviewCard(card.id)!.stage).toBe(1);
  });
});

describe("next-step", () => {
  it("prioritizes due reviews, then weakest node, then new", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "n1", nodeIds: [NODE_A], stem: "题", answer: "1" })]);
    const learner = repo.createLearner("下一步生", "elementary_upper");

    let res = await app.request(`/api/v1/practice/next-step?learnerId=${learner.id}`);
    expect((await res.json()).kind).toBe("new");

    repo.upsertMastery({ learnerId: learner.id, nodeId: NODE_A, p: 0.3, evidenceN: 2, lastEvidenceAt: new Date().toISOString() });
    res = await app.request(`/api/v1/practice/next-step?learnerId=${learner.id}`);
    expect((await res.json()).kind).toBe("weak");

    repo.upsertReviewCard(learner.id, "question", "n1", new Date(Date.now() - 1000).toISOString());
    res = await app.request(`/api/v1/practice/next-step?learnerId=${learner.id}`);
    const body = await res.json();
    expect(body.kind).toBe("review");
    expect(body.nextStep).toContain("复习");
  });
});

describe("parent summary & verdict", () => {
  it("aggregates mistakes, exposes pending verdicts, verdict backfills mastery", async () => {
    const { app, repo } = makeApp([
      makeQuestion({ id: "p1", nodeIds: [NODE_A], stem: "主观题", answer: "先加后减", answerType: "steps" }),
    ]);
    const learner = repo.createLearner("家长测", "elementary_upper");
    // 主观题 → pending 进抽检
    await post(app, "/api/v1/practice/submit", { learnerId: learner.id, questionId: "p1", answer: "我的思路是……" });

    let summary = await (await app.request(`/api/v1/parent/summary?learnerId=${learner.id}`)).json();
    expect(summary.pendingVerdicts.length).toBe(1);
    expect(summary.pendingVerdicts[0].correctAnswer).toBe("先加后减");
    expect(repo.allMastery(learner.id)).toEqual([]); // 未裁决不计证据

    const verdict = await post(app, "/api/v1/parent/verdict", {
      attemptId: summary.pendingVerdicts[0].attemptId, verdict: "correct",
    });
    expect(verdict.body.ok).toBe(true);
    expect(verdict.body.mastery.length).toBe(1);
    expect(repo.allMastery(learner.id).length).toBe(1); // 裁决后补记

    summary = await (await app.request(`/api/v1/parent/summary?learnerId=${learner.id}`)).json();
    expect(summary.pendingVerdicts.length).toBe(0);
    expect(summary.trend.length).toBeGreaterThan(0);
  });

  it("correct-mistake marks corrected and can repoint root", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "m1", nodeIds: [NODE_A], stem: "错题", answer: "3" })]);
    const learner = repo.createLearner("纠错测", "elementary_upper");
    const attempt = repo.insertAttempt({
      learnerId: learner.id, questionId: "m1", answer: "9",
      correct: false, hintLevelUsed: 3, source: "daily", needsReview: false,
    });
    const diag = await post(app, `/api/v1/diagnosis/${attempt.id}`, {});
    const res = await post(app, "/api/v1/parent/correct-mistake", {
      mistakeId: diag.body.mistakeId, rootNodeId: NODE_B,
    });
    expect(res.body.ok).toBe(true);
    const m = repo.getMistake(diag.body.mistakeId)!;
    expect(m.rootNodeId).toBe(NODE_B);
  });
});

describe("photo grading", () => {
  it("confident extraction grades deterministically; unconfident goes to parent queue", async () => {
    const env = makeApp([makeQuestion({ id: "ph1", nodeIds: [NODE_A], stem: "8+5 的周长题", answer: "26" })]);
    const learner = env.repo.createLearner("拍照生", "elementary_upper");

    env.state.photoGrader = { extractAnswer: async () => ({ answer: "26 厘米", confident: true }) };
    const appWithVision = createApp(env.state);
    const ok = await post(appWithVision, "/api/v1/practice/submit-photo", {
      learnerId: learner.id, questionId: "ph1", image: "data:image/jpeg;base64,AAAA",
    });
    expect(ok.body.correct).toBe(true);
    expect(ok.body.needsReview).toBe(false);
    expect(ok.body.mastery.length).toBe(1);

    env.state.photoGrader = { extractAnswer: async () => ({ answer: "26?", confident: false }) };
    const appUnsure = createApp(env.state);
    const unsure = await post(appUnsure, "/api/v1/practice/submit-photo", {
      learnerId: learner.id, questionId: "ph1", image: "AAAA",
    });
    expect(unsure.body.needsReview).toBe(true);
    expect(unsure.body.mastery).toEqual([]); // 低置信不计证据

    env.state.photoGrader = null;
    const appNoVision = createApp(env.state);
    const off = await post(appNoVision, "/api/v1/practice/submit-photo", {
      learnerId: learner.id, questionId: "ph1", image: "AAAA",
    });
    expect(off.status).toBe(501);
  });
});

/**
 * 待批改条数：导航角标用的。
 *
 * 判不准的作答转给家长是对的，但此前转过去就没下文了——孩子看到
 * "已交给家长确认"，家长那边一点动静都没有，那几道题就一直悬着。
 */
describe("GET /api/v1/parent/pending-count", () => {
  it("只回一个数，够导航挂角标", async () => {
    const env = makeApp([makeQuestion({ id: "q1", answer: "乙和丁", answerType: "steps" })]);
    const app = env.app;
    const learner = env.repo.createLearner("小明", "elementary_upper");

    const before = (await (
      await app.request(`/api/v1/parent/pending-count?learnerId=${learner.id}`)
    ).json()) as { count: number };
    expect(before.count).toBe(0);

    env.repo.insertAttempt({
      learnerId: learner.id,
      questionId: "q1",
      answer: "丙和丁",
      correct: false,
      hintLevelUsed: 0,
      source: "daily",
      needsReview: true,
    });

    const after = (await (
      await app.request(`/api/v1/parent/pending-count?learnerId=${learner.id}`)
    ).json()) as { count: number };
    expect(after.count).toBe(1);
  });

  it("没有 learnerId 时回 0，不报错——角标不该把页面拖垮", async () => {
    const { app } = makeApp([]);
    const res = await app.request("/api/v1/parent/pending-count");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { count: number }).count).toBe(0);
  });
});

/**
 * 清空学习记录：题库推倒重建后，掌握度、复习卡、错题全指着不存在的旧题，
 * 星图亮着不该亮的星。账号不动，只清学习痕迹。
 */
describe("POST /api/v1/parent/reset-learner", () => {
  it("清空六张表，账号与题库不动", async () => {
    const env = makeApp([makeQuestion({ id: "q1", nodeIds: [NODE_A], stem: "题", answer: "1" })]);
    const learner = env.repo.createLearner("小明", "elementary_upper");
    env.repo.insertAttempt({
      learnerId: learner.id,
      questionId: "q1",
      answer: "1",
      correct: true,
      hintLevelUsed: 0,
      source: "daily",
      needsReview: false,
    });
    env.repo.upsertMastery({
      learnerId: learner.id,
      nodeId: NODE_A,
      p: 0.6,
      evidenceN: 1,
      lastEvidenceAt: new Date().toISOString(),
    });

    const res = await env.app.request("/api/v1/parent/reset-learner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learnerId: learner.id, confirm: "小明" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cleared: { table: string; removed: number }[] };
    expect(body.cleared.reduce((n, c) => n + c.removed, 0)).toBe(2);

    // 学习痕迹清空，账号还在，题库不动
    expect(env.repo.allMastery(learner.id)).toEqual([]);
    expect(env.repo.attemptedQuestionIds(learner.id).size).toBe(0);
    expect(env.repo.getLearner(learner.id)?.name).toBe("小明");
    expect(env.state.questions.all).toHaveLength(1);
  });

  it("名字输错不清——防手滑的最后一道闸", async () => {
    const env = makeApp([]);
    const learner = env.repo.createLearner("小明", "elementary_upper");
    env.repo.upsertMastery({
      learnerId: learner.id,
      nodeId: NODE_A,
      p: 0.6,
      evidenceN: 1,
      lastEvidenceAt: new Date().toISOString(),
    });
    const res = await env.app.request("/api/v1/parent/reset-learner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learnerId: learner.id, confirm: "小名" }),
    });
    expect(res.status).toBe(400);
    expect(env.repo.allMastery(learner.id)).toHaveLength(1);
  });
})
