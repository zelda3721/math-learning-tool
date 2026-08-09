import { describe, expect, it } from "vitest";
import { makeApp, makeQuestion, NODE_A } from "./helpers.js";

async function post(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("practice end-to-end flow", () => {
  it("create learner → today → wrong → hint → correct → mastery rises & atlas colors", async () => {
    const { app } = makeApp([
      makeQuestion({ id: "q1", stem: "长方形长8宽5，周长？", answer: "26", nodeIds: [NODE_A] }),
      makeQuestion({ id: "q2", stem: "备用题", answer: "7", nodeIds: [NODE_A] }),
    ]);

    // 建学习者
    const created = await post(app, "/api/v1/learners", { name: "点点", level: "elementary_upper" });
    expect(created.status).toBe(201);
    const learnerId = created.body.learner.id as string;

    // 今日组卷：拿到题且不含答案
    const today = await post(app, "/api/v1/practice/today", { learnerId });
    expect(today.status).toBe(200);
    expect(today.body.items.length).toBeGreaterThan(0);
    const q = today.body.items[0].question;
    expect(q.id).toBe("q1");
    expect(q).not.toHaveProperty("answer");
    expect(q).not.toHaveProperty("analysis");

    // 答错 → 可提示
    const wrong = await post(app, "/api/v1/practice/submit", {
      learnerId,
      questionId: "q1",
      answer: "24",
    });
    expect(wrong.body.correct).toBe(false);
    expect(wrong.body.hintAvailable).toBe(true);

    // 提示阶梯（无 LLM → 静态兜底，且绝不泄漏答案 26）
    const hint = await post(app, "/api/v1/practice/hint", {
      learnerId,
      questionId: "q1",
      level: 1,
      lastWrongAnswer: "24",
    });
    expect(hint.status).toBe(200);
    expect(hint.body.source).toBe("static");
    expect(hint.body.hint).not.toContain("26");

    // 用了 L1 提示后答对 → 掌握度上升但打了折扣
    const correct = await post(app, "/api/v1/practice/submit", {
      learnerId,
      questionId: "q1",
      answer: "26 厘米",
      hintLevelUsed: 1,
    });
    expect(correct.body.correct).toBe(true);
    expect(correct.body.mastery.length).toBe(1);
    const nodeMastery = correct.body.mastery[0];
    expect(nodeMastery.nodeId).toBe(NODE_A);

    // 星图带该生掌握度
    const atlas = await app.request(`/api/v1/atlas?learnerId=${learnerId}`);
    const atlasBody = await atlas.json();
    expect(atlasBody.mastery[NODE_A]).toBeDefined();
    expect(atlasBody.mastery[NODE_A].evidenceN).toBe(2);
    expect(["dim", "glow", "lit"]).toContain(atlasBody.mastery[NODE_A].band);
  });

  it("steps answers are pending and do not touch mastery", async () => {
    const { app, repo } = makeApp([
      makeQuestion({ id: "s1", stem: "说说你的思路", answer: "先加后乘", answerType: "steps" }),
    ]);
    const created = await post(app, "/api/v1/learners", { name: "豆豆", level: "elementary_upper" });
    const learnerId = created.body.learner.id as string;
    const res = await post(app, "/api/v1/practice/submit", {
      learnerId,
      questionId: "s1",
      answer: "我随便写的",
    });
    expect(res.body.needsReview).toBe(true);
    expect(res.body.mastery).toEqual([]);
    expect(repo.allMastery(learnerId)).toEqual([]);
  });
});
