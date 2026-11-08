import { describe, expect, it } from "vitest";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { ASSESSMENT_SCHEDULE, compareAssessments, nextAssessment } from "../src/assessment.js";
import { makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

/**
 * 阶段测评（前测 / 后测 / 保持率）。
 *
 * 这批测试守的是"测量别变成装饰"的四条：
 * ① 测评不写 attempts、不动掌握度；
 * ② 作答过程中不回对错（否则后面的题被前一道的反馈带跑）；
 * ③ 题不够时如实标 reused，不假装是新题；
 * ④ 调度按 7 天 / 28 天走，且每档只做一次。
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

function makeEnv(count = 8) {
  const questions = Array.from({ length: count }, (_, i) =>
    makeQuestion({ id: `a${i}`, nodeIds: [NODE_A], stem: `测评题 ${i}`, answer: String(10 + i) }),
  );
  const env = tempFixtureEnv(questions);
  const db = openMemoryDb();
  const state: AppState = { ...env.state, repo: new Repo(db), auth: new AuthStore(db), authDisabled: false };
  return { ...env, state, app: createApp(state) };
}

async function withChild(env: ReturnType<typeof makeEnv>) {
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

describe("测评流程", () => {
  it("开一份前测：题面下发、答案不下发、没有提示", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const res = await child.call("POST", "/api/v1/assessment/start", { kind: "pre", learnerId });
    expect(res.status).toBe(200);
    expect(res.body.questions.length).toBeGreaterThan(0);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('"answer"');
    expect(res.body.note).toContain("没有提示");
  });

  it("作答时不回对错；交卷才给结果", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const start = await child.call("POST", "/api/v1/assessment/start", { kind: "pre", learnerId });
    const q = start.body.questions[0];

    const answer = await child.call("POST", `/api/v1/assessment/${start.body.id}/answer`, {
      learnerId,
      questionId: q.id,
      answer: "999",
    });
    expect(answer.status).toBe(200);
    expect(answer.body.recorded).toBe(true);
    expect(answer.body).not.toHaveProperty("correct");

    // 只答一道就想交卷：不到一半，拒（不然跳过难题就能刷高正确率）
    const tooFew = await child.call("POST", `/api/v1/assessment/${start.body.id}/finish`, { learnerId });
    expect(tooFew.status).toBe(409);

    const total = start.body.questions.length as number;
    const half = Math.ceil(total / 2);
    for (const other of start.body.questions.slice(1, half)) {
      await child.call("POST", `/api/v1/assessment/${start.body.id}/answer`, { learnerId, questionId: other.id, answer: "999" });
    }
    const fin = await child.call("POST", `/api/v1/assessment/${start.body.id}/finish`, { learnerId });
    expect(fin.status).toBe(200);
    expect(fin.body.summary.answered).toBe(half);
    expect(fin.body.summary.correct).toBe(0);
    // 没答的那一半算进分母、按没答对算
    expect(fin.body.summary.skipped).toBe(total - half);
    expect(fin.body.summary.rate).toBe(0);
    expect(fin.body.summary.items[0].reference).toBeTruthy();
  });

  it("测评不写 attempts、不动掌握度", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const start = await child.call("POST", "/api/v1/assessment/start", { kind: "pre", learnerId });
    const q = start.body.questions[0];
    await child.call("POST", `/api/v1/assessment/${start.body.id}/answer`, {
      learnerId,
      questionId: q.id,
      answer: "10",
    });
    await child.call("POST", `/api/v1/assessment/${start.body.id}/finish`, { learnerId });

    expect(env.state.repo.attemptsForEvidence(learnerId)).toHaveLength(0);
    expect(env.state.repo.getMastery(learnerId, NODE_A)).toBeUndefined();
  });

  it("同一题再答 → 409；交卷后再作答 → 410（前端据此去看结果，而不是当成已记下）", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const start = await child.call("POST", "/api/v1/assessment/start", { kind: "pre", learnerId });
    const questions = start.body.questions as { id: string }[];
    const q = questions[0]!;
    for (const item of questions) {
      await child.call("POST", `/api/v1/assessment/${start.body.id}/answer`, { learnerId, questionId: item.id, answer: "10" });
    }
    const dup = await child.call("POST", `/api/v1/assessment/${start.body.id}/answer`, { learnerId, questionId: q.id, answer: "11" });
    expect(dup.status).toBe(409);
    const fin = await child.call("POST", `/api/v1/assessment/${start.body.id}/finish`, { learnerId });
    expect(fin.status).toBe(200);
    const again = await child.call("POST", `/api/v1/assessment/${start.body.id}/answer`, {
      learnerId,
      questionId: q.id,
      answer: "10",
    });
    expect(again.status).toBe(410);
  });

  it("并发两次交同一题：只记先到的那次", async () => {
    const env = makeEnv();
    const { learnerId } = await withChild(env);
    const id = env.state.repo.createAssessment(learnerId, "pre", [NODE_A], ["a0"]);
    expect(env.state.repo.answerAssessmentItem(id, "a0", "1", true)).toBe(true);
    expect(env.state.repo.answerAssessmentItem(id, "a0", "2", false)).toBe(false);
    const item = env.state.repo.listAssessmentItems(id)[0]!;
    expect(item.answer).toBe("1");
    expect(item.correct).toBe(true);
    // 判不准存 NULL
    const id2 = env.state.repo.createAssessment(learnerId, "pre", [NODE_A], ["a0"]);
    env.state.repo.answerAssessmentItem(id2, "a0", "x", null);
    expect(env.state.repo.listAssessmentItems(id2)[0]!.correct).toBeNull();
  });

  it("孩子不能碰别人的测评", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const start = await child.call("POST", "/api/v1/assessment/start", { kind: "pre", learnerId });
    const other = client(env.app);
    await other.call("POST", "/api/v1/auth/register-child", {
      username: "小红",
      password: "child-secret",
      level: "elementary_upper",
    });
    const res = await other.call("POST", `/api/v1/assessment/${start.body.id}/finish`, {});
    expect(res.status).toBe(404);
  });
});

describe("测评调度", () => {
  it("没有前测先做前测；满 7 天做后测；满 28 天做保持率", async () => {
    const env = makeEnv();
    const { learnerId } = await withChild(env);
    const repo = env.state.repo;

    expect(nextAssessment(repo, learnerId)?.kind).toBe("pre");

    const pre = repo.createAssessment(learnerId, "pre", [NODE_A], ["a0"]);
    repo.finishAssessment(pre);
    const day3 = new Date(Date.now() + 3 * 86_400_000);
    const soon = nextAssessment(repo, learnerId, day3)!;
    expect(soon.kind).toBe("post");
    expect(soon.dueAt).toBeTruthy();

    const day8 = new Date(Date.now() + 8 * 86_400_000);
    expect(nextAssessment(repo, learnerId, day8)?.kind).toBe("post");

    const post = repo.createAssessment(learnerId, "post", [NODE_A], ["a1"]);
    repo.finishAssessment(post);
    const day20 = new Date(Date.now() + 20 * 86_400_000);
    expect(nextAssessment(repo, learnerId, day20)?.dueAt).toBeTruthy();

    const day30 = new Date(Date.now() + 30 * 86_400_000);
    expect(nextAssessment(repo, learnerId, day30)?.kind).toBe("retention");

    const retention = repo.createAssessment(learnerId, "retention", [NODE_A], ["a2"]);
    repo.finishAssessment(retention);
    const day60 = new Date(Date.now() + 60 * 86_400_000);
    expect(nextAssessment(repo, learnerId, day60)).toBeNull();
    void ASSESSMENT_SCHEDULE;
  });
});

describe("前后测对比", () => {
  it("只比两次都覆盖到的节点，给每个节点的变化", () => {
    const cmp = compareAssessments(
      { kind: "pre", byNode: [{ nodeId: "n1", correct: 0, total: 1 }, { nodeId: "n2", correct: 1, total: 1 }] },
      { kind: "post", byNode: [{ nodeId: "n1", correct: 1, total: 1 }, { nodeId: "n3", correct: 0, total: 1 }] },
    );
    expect(cmp.nodes).toHaveLength(1);
    expect(cmp.nodes[0]!.nodeId).toBe("n1");
    expect(cmp.nodes[0]!.delta).toBe(1);
    expect(cmp.overall.beforeRate).toBe(0);
    expect(cmp.overall.afterRate).toBe(1);
  });
});

describe("家长端测评对比", () => {
  it("做完前测能看到 next 提示；没有后测时 preToPost 为 null", async () => {
    const env = makeEnv();
    const { parent, child, learnerId } = await withChild(env);
    const start = await child.call("POST", "/api/v1/assessment/start", { kind: "pre", learnerId });
    for (const item of start.body.questions as { id: string }[]) {
      await child.call("POST", `/api/v1/assessment/${start.body.id}/answer`, { learnerId, questionId: item.id, answer: "10" });
    }
    const fin = await child.call("POST", `/api/v1/assessment/${start.body.id}/finish`, { learnerId });
    expect(fin.status).toBe(200);

    const res = await parent.call("GET", `/api/v1/parent/assessments?learnerId=${learnerId}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.preToPost).toBeNull();
    expect(res.body.next.kind).toBe("post");
  });
});
