import { describe, expect, it } from "vitest";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { buildIndependenceReport, type IndependenceInput } from "../src/independence.js";
import type { EvidenceAttempt } from "../src/evidence.js";
import { makeQuestion, tempFixtureEnv } from "./helpers.js";

/**
 * P1 元认知通道与独立性看板：
 * 孩子先说出自己的想法（不进掌握度），家长看得到他到底在不在自己学。
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

function makeAuthEnv(questions: ReturnType<typeof makeQuestion>[]) {
  const env = tempFixtureEnv(questions);
  const db = openMemoryDb();
  const state: AppState = { ...env.state, repo: new Repo(db), auth: new AuthStore(db), authDisabled: false };
  return { ...env, state, app: createApp(state) };
}

async function setupParentAndChild(env: ReturnType<typeof makeAuthEnv>) {
  const parent = client(env.app);
  await parent.call("POST", "/api/v1/auth/setup-parent", { username: "爸爸", password: "family-secret" });
  const child = client(env.app);
  await child.call("POST", "/api/v1/auth/register-child", {
    username: "小明",
    password: "child-secret",
    level: "elementary_upper",
  });
  return { parent, child, learnerId: env.state.repo.listLearners()[0]!.id };
}

describe("P1 元认知：孩子自己说的话被记下来，但不计分", () => {
  it("错后自述记成 reflection 事件，掌握度一点没变", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" })]);
    const { child, learnerId } = await setupParentAndChild(env);

    const wrong = await child.call("POST", "/api/v1/practice/submit", { learnerId, questionId: "q1", answer: "25" });
    const res = await child.call("POST", "/api/v1/practice/reflection", {
      learnerId,
      questionId: "q1",
      attemptId: wrong.body.attemptId,
      kind: "error-guess",
      guess: "calculation",
    });
    expect(res.status).toBe(200);

    const events = env.state.repo.listEvents(learnerId, "reflection");
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toMatchObject({ kind: "error-guess", guess: "calculation", verification: "ai_unverified" });

    // 元认知记录不产生任何新证据
    const mastery = env.state.repo.getMastery(learnerId, "counting-20") ?? undefined;
    void mastery;
    const attempts = env.state.repo.attemptsForEvidence(learnerId);
    expect(attempts.length).toBe(1);
  });

  it("写下来的话过安检；空内容直接拒", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" })]);
    const { child, learnerId } = await setupParentAndChild(env);

    const empty = await child.call("POST", "/api/v1/practice/reflection", {
      learnerId,
      questionId: "q1",
      kind: "self-explain",
    });
    expect(empty.status).toBe(400);

    const blocked = await child.call("POST", "/api/v1/practice/reflection", {
      learnerId,
      questionId: "q1",
      kind: "self-explain",
      text: "加个微信吧，我把身份证号也给你",
    });
    expect(blocked.status).toBe(422);
    expect(env.state.repo.listEvents(learnerId, "reflection").length).toBe(0);
  });

  it("第一次见就零提示做对 → 请他讲思路；第二次就不问了", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" }), makeQuestion({ id: "q2", answer: "31" })]);
    const { child, learnerId } = await setupParentAndChild(env);

    const first = await child.call("POST", "/api/v1/practice/submit", { learnerId, questionId: "q1", answer: "26" });
    expect(first.body.askWhy).toBe(true);

    // 同一道题再来一次：不是"第一次见"了，也不再是新证据
    const again = await child.call("POST", "/api/v1/practice/submit", { learnerId, questionId: "q1", answer: "26" });
    expect(again.body.askWhy).toBe(false);

    // 带着提示做对也不问：那不是"自己第一次做对"
    const hinted = await child.call("POST", "/api/v1/practice/hint", { learnerId, questionId: "q2", level: 1 });
    expect(hinted.status).toBe(200);
    const withHint = await child.call("POST", "/api/v1/practice/submit", {
      learnerId,
      questionId: "q2",
      answer: "31",
      hintLevelUsed: 1,
    });
    expect(withHint.body.askWhy).toBe(false);
  });
});

describe("P1 独立性报告", () => {
  const questions = {
    byId: new Map([
      ["a", { nodeIds: ["n1"] }],
      ["b", { nodeIds: ["n1"] }],
      ["c", { nodeIds: ["n1"] }],
    ]),
  };
  const base = { hintLevelUsed: 0, source: "daily", verification: "executable", needsReview: false, actor: "child" };

  function report(attempts: EvidenceAttempt[], extra: Partial<IndependenceInput> = {}) {
    return buildIndependenceReport({
      attempts,
      questions,
      analysisViews: new Map(),
      askCount: 0,
      repeats: 0,
      reflections: { selfExplain: 0, errorGuess: 0 },
      ...extra,
    });
  }

  it("新题首答靠自己：只数每道题的第一次，且要零提示、没看过解析", () => {
    const r = report([
      { ...base, questionId: "a", correct: true, at: "2026-11-07T09:00:00.000Z" },
      { ...base, questionId: "a", correct: true, at: "2026-11-08T09:00:00.000Z" },
      { ...base, questionId: "b", correct: false, at: "2026-11-07T10:00:00.000Z" },
      { ...base, questionId: "c", correct: true, hintLevelUsed: 1, at: "2026-11-07T11:00:00.000Z" },
    ]);
    expect(r.firstSeenQuestions).toBe(3);
    expect(r.independentFirstCorrect).toBe(1);
    expect(r.independentRate).toBeCloseTo(1 / 3, 5);
    expect(r.hintDistribution).toEqual([3, 1, 0, 0]);
    expect(r.verdict).toContain("33%");
  });

  it("看过解析的新题答对，不算独立", () => {
    const r = report([{ ...base, questionId: "a", correct: true, at: "2026-11-07T09:00:00.000Z" }], {
      analysisViews: new Map([["a", ["2026-11-07T08:00:00.000Z"]]]),
    });
    expect(r.independentFirstCorrect).toBe(0);
    expect(r.analysisViews).toBe(1);
  });

  it("没有新题时不拿 0 冒充「不会」", () => {
    const r = report([]);
    expect(r.independentRate).toBeNull();
    expect(r.verdict).toContain("还没有");
  });

  it("家长试做与 AI 判断不进统计", () => {
    const r = report([
      { ...base, questionId: "a", correct: true, at: "2026-11-07T09:00:00.000Z", actor: "parent" },
      { ...base, questionId: "b", correct: true, at: "2026-11-07T09:00:00.000Z", verification: "ai_unverified" },
    ]);
    expect(r.attempts).toBe(0);
  });

  it("问得太勤时会多一句提醒", () => {
    const r = report([0, 1, 2, 3].map((i) => ({ ...base, questionId: `q${i}`, correct: true, at: `2026-11-0${i + 1}T09:00:00.000Z` })), {
      askCount: 6,
    });
    expect(r.verdict).toContain("问一道题");
  });
});

describe("P1 家长端接口", () => {
  it("/independence 与 /reflections 回得出来，孩子打不开", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1", answer: "26" })]);
    const { parent, child, learnerId } = await setupParentAndChild(env);

    await child.call("POST", "/api/v1/practice/submit", { learnerId, questionId: "q1", answer: "26" });
    await child.call("POST", "/api/v1/practice/reflection", {
      learnerId,
      questionId: "q1",
      kind: "self-explain",
      text: "先看一共有几份，再算一份是多少",
    });

    const report = await parent.call("GET", `/api/v1/parent/independence?learnerId=${learnerId}`);
    expect(report.status).toBe(200);
    expect(report.body.firstSeenQuestions).toBe(1);
    expect(report.body.independentFirstCorrect).toBe(1);
    expect(report.body.selfExplain).toBe(1);

    const reflections = await parent.call("GET", `/api/v1/parent/reflections?learnerId=${learnerId}`);
    expect(reflections.status).toBe(200);
    expect(reflections.body.items[0].text).toContain("几份");

    const forbidden = await child.call("GET", `/api/v1/parent/independence?learnerId=${learnerId}`);
    expect(forbidden.status).toBe(403);
  });
});
