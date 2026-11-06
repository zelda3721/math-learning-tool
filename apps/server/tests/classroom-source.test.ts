import { describe, expect, it } from "vitest";
import { makeApp, makeQuestion, NODE_A } from "./helpers.js";

/**
 * 课堂作答进证据链（阶段 3）。
 *
 * 课堂里答的题与课后练习不是同一种证据：它产生在教学流程中间，带着"讲到哪一拍"的上下文。
 * 混进 daily 会把两种证据搅成一种，事后分不开——所以 source 单列，且要真的落库。
 */

async function post(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("source=classroom", () => {
  it("课堂作答能提交，且按 executable 计入掌握度", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "q1", stem: "长方形长8宽5，周长？", answer: "26" })]);
    const learner = await post(app, "/api/v1/learners", { name: "点点", level: "elementary_upper" });
    const learnerId = learner.body.learner.id as string;

    const res = await post(app, "/api/v1/practice/submit", {
      learnerId,
      questionId: "q1",
      answer: "26",
      source: "classroom",
    });

    expect(res.status).toBe(200);
    expect(res.body.correct).toBe(true);
    expect(res.body.verification).toBe("executable");
    expect(res.body.countedTowardMastery).toBe(true);
    // 星图真的亮了：课堂作答不是"看过算过"
    expect(repo.getMastery(learnerId, NODE_A)?.evidenceN).toBe(1);
  });

  it("来源落库为 classroom，不与 daily 混在一起", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "q1", answer: "26" })]);
    const learner = await post(app, "/api/v1/learners", { name: "点点", level: "elementary_upper" });
    const learnerId = learner.body.learner.id as string;

    const res = await post(app, "/api/v1/practice/submit", {
      learnerId, questionId: "q1", answer: "26", source: "classroom",
    });
    expect(repo.getAttempt(res.body.attemptId)?.source).toBe("classroom");
  });

  it("不认识来源会被拒（枚举不会因为加了 classroom 就变宽松）", async () => {
    const { app } = makeApp([makeQuestion({ id: "q1", answer: "26" })]);
    const learner = await post(app, "/api/v1/learners", { name: "点点", level: "elementary_upper" });
    const res = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.body.learner.id, questionId: "q1", answer: "26", source: "whatever",
    });
    expect(res.status).toBe(400);
  });
});
