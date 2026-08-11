/**
 * 「答案是模型自己算的」这条线。
 *
 * 学生版讲义不印答案，抽取时模型会按提示自己解一个——而它解得不稳：
 * 同一道数三角形的题两次分别给出 48 和 84。拿这种数去判卷，
 * 孩子做对了会被判错，而他会开始怀疑自己而不是怀疑系统。
 *
 * 所以这条线要从头守到尾：抽取时标出来 → 跟着题进库 → 没人核对就不发给孩子 →
 * 家长核对过才放行。任何一环断了都不报错，只会悄悄退化成"拿猜的数判卷"。
 */
import { describe, expect, it } from "vitest";
import { composeToday } from "../src/composer.js";
import { practiceReady } from "../src/questions.js";
import { createApp } from "../src/app.js";
import { knowledge, makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

describe("practiceReady", () => {
  it("答案是模型自己算的、又没人核对 → 不发给孩子", () => {
    expect(practiceReady(makeQuestion({ id: "q", answerUnverified: true, status: "extracted" }))).toBe(false);
  });

  it("家长核对过就放行——那时这个数已经有人看过了", () => {
    expect(practiceReady(makeQuestion({ id: "q", answerUnverified: true, status: "verified" }))).toBe(true);
  });

  it("答案有出处的题不受影响，哪怕还没抽检", () => {
    // 手头几十份讲义，一次性抽检完不现实。真正危险的只是模型猜答案那一小撮，
    // 拦下所有没抽检的题等于题库建好了却没题可做。
    expect(practiceReady(makeQuestion({ id: "q", status: "extracted" }))).toBe(true);
  });
});

describe("出题时把这类题挡在外面", () => {
  it("每日练习不会选到它", () => {
    const questions = [
      makeQuestion({ id: "guessed", nodeIds: [NODE_A], stem: "数三角形", answer: "48", answerUnverified: true, status: "extracted" }),
      makeQuestion({ id: "sourced", nodeIds: [NODE_A], stem: "长方形周长", answer: "26" }),
    ];
    const { store, repo } = tempFixtureEnv(questions);
    const learner = repo.createLearner("小明", "elementary_upper");
    const ids = composeToday(store, knowledge.index, repo, learner.id, { count: 5 }).map(
      (c) => c.question.id,
    );
    expect(ids).not.toContain("guessed");
    expect(ids).toContain("sourced");
  });

  it("核对之后就能被选中了", () => {
    const questions = [
      makeQuestion({
        id: "guessed",
        nodeIds: [NODE_A],
        stem: "数三角形",
        answer: "48",
        answerUnverified: true,
        status: "verified",
      }),
    ];
    const { store, repo } = tempFixtureEnv(questions);
    const learner = repo.createLearner("小明", "elementary_upper");
    const ids = composeToday(store, knowledge.index, repo, learner.id, { count: 5 }).map(
      (c) => c.question.id,
    );
    expect(ids).toContain("guessed");
  });
});

describe("标记要跟着题进库", () => {
  const draft = {
    stem: "下图的手绢里共有多少个三角形？",
    answer: "48",
    answerType: "numeric" as const,
    difficulty: 3,
    level: "elementary_upper" as const,
    nodeIds: [NODE_A],
  };

  async function confirm(app: ReturnType<typeof createApp>, body: unknown) {
    return app.request("/api/v1/ingest/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("入库后仍分得清哪些答案是模型自己算的", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);
    await confirm(app, {
      batchName: "t",
      questions: [{ ...draft, answerUnverified: true }],
    });
    const stored = env.state.questions.all.find((q) => q.stem === draft.stem);
    expect(stored?.answerUnverified).toBe(true);
    expect(practiceReady(stored!)).toBe(false);
  });

  it("答案有出处的题不带这个标记", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);
    await confirm(app, { batchName: "t", questions: [draft] });
    const stored = env.state.questions.all.find((q) => q.stem === draft.stem);
    expect(stored?.answerUnverified).toBeUndefined();
    expect(practiceReady(stored!)).toBe(true);
  });

  it("抽检列表报出有几道题现在拿不到孩子手上", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);
    await confirm(app, {
      batchName: "t",
      questions: [{ ...draft, answerUnverified: true }, { ...draft, stem: "长方形周长？", answer: "26" }],
    });
    const body = (await (await app.request("/api/v1/ingest/questions?status=extracted")).json()) as {
      extracted: number;
      blocked: number;
    };
    expect(body.extracted).toBe(2);
    expect(body.blocked).toBe(1);
  });

  it("家长核验通过后，这道题就能进练习了", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);
    await confirm(app, { batchName: "t", questions: [{ ...draft, answerUnverified: true }] });
    const id = env.state.questions.all.find((q) => q.stem === draft.stem)!.id;

    const res = await app.request("/api/v1/ingest/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: id, verdict: "verified" }),
    });
    expect(res.status).toBe(200);
    expect(practiceReady(env.state.questions.byId.get(id)!)).toBe(true);
  });
});

describe("题库页能把这批题捞出来", () => {
  it("blocked=1 只返回这类题，facet 给出总数", async () => {
    const env = tempFixtureEnv([
      makeQuestion({ id: "guessed", stem: "数三角形", answer: "48", answerUnverified: true, status: "extracted" }),
      makeQuestion({ id: "sourced", stem: "长方形周长", answer: "26" }),
      makeQuestion({ id: "checked", stem: "数正方形", answer: "9", answerUnverified: true, status: "verified" }),
    ]);
    const app = createApp(env.state);
    const body = (await (await app.request("/api/v1/bank/questions?blocked=1")).json()) as {
      items: { id: string }[];
      facets: { blocked: number };
    };
    expect(body.items.map((i) => i.id)).toEqual(["guessed"]);
    expect(body.facets.blocked).toBe(1);
  });
});
