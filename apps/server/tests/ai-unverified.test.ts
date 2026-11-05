import { describe, expect, it } from "vitest";
import { makeApp, makeQuestion, NODE_A } from "./helpers.js";
import type { AnswerJudge } from "../src/semanticJudge.js";

/**
 * 宪法第 5 条的落地：只有 AI 判断的作答，**不进掌握度**。
 *
 * 这条路径具体是：规则判卷器判不准（pending）→ 问模型「是不是同一个意思」→
 * 模型说"对"。从前这个"对"会被当成 executable 证据点亮星图；
 * 现在它记进作答、留审计事件，但不算数。
 *
 * 为什么必须这样：一颗不该亮的星亮起来，孩子会以为自己会了，
 * 家长也无从分辨——而且事后没有任何数据能把它挑出来。
 */

const SUBJECTIVE = makeQuestion({
  id: "q-subj",
  stem: "说说长方形周长的算法",
  answer: "先算周长公式",
  answerType: "steps",
});

async function post(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const alwaysCorrect: AnswerJudge = async () => ({ verdict: "correct", why: "表达的是同一件事" });

describe("AI 判卷确认的作答", () => {
  it("判成对、但标注 ai_unverified 且不计入掌握度", async () => {
    const { app, repo } = makeApp([SUBJECTIVE], { judge: alwaysCorrect });
    const learner = await post(app, "/api/v1/learners", { name: "点点", level: "elementary_upper" });
    const learnerId = learner.body.learner.id as string;

    const res = await post(app, "/api/v1/practice/submit", {
      learnerId,
      questionId: "q-subj",
      answer: "我先把长和宽加起来再乘二",
    });

    expect(res.body.correct).toBe(true);
    expect(res.body.verification).toBe("ai_unverified");
    expect(res.body.countedTowardMastery).toBe(false);
    expect(res.body.mastery).toEqual([]);
    // 星图上一颗星都不该因此亮起
    expect(repo.getMastery(learnerId, NODE_A)).toBeUndefined();
  });

  it("审计事件里写明这条「对」不算数（家长要看得见）", async () => {
    const { app, repo } = makeApp([SUBJECTIVE], { judge: alwaysCorrect });
    const learner = await post(app, "/api/v1/learners", { name: "点点", level: "elementary_upper" });
    const learnerId = learner.body.learner.id as string;
    await post(app, "/api/v1/practice/submit", {
      learnerId,
      questionId: "q-subj",
      answer: "我先把长和宽加起来再乘二",
    });

    const events = repo.listEvents(learnerId);
    const accepted = events.find((e) => e.type === "ai_judge_accepted");
    expect(accepted).toBeDefined();
    expect((accepted!.payload as { verification?: string }).verification).toBe("ai_unverified");
  });

  it("没有语义判卷时，同一道题仍走 pending 交家长", async () => {
    const { app } = makeApp([SUBJECTIVE]);
    const learner = await post(app, "/api/v1/learners", { name: "点点", level: "elementary_upper" });
    const learnerId = learner.body.learner.id as string;

    const res = await post(app, "/api/v1/practice/submit", {
      learnerId,
      questionId: "q-subj",
      answer: "我先把长和宽加起来再乘二",
    });
    expect(res.body.method).toBe("pending");
    expect(res.body.needsReview).toBe(true);
    expect(res.body.countedTowardMastery).toBe(false);
  });

  it("规则判得出来的作答照旧计入掌握度（这一改没有误伤正常路径）", async () => {
    const numeric = makeQuestion({ id: "q-num", stem: "长方形长8宽5，周长？", answer: "26" });
    const { app, repo } = makeApp([numeric], { judge: alwaysCorrect });
    const learner = await post(app, "/api/v1/learners", { name: "点点", level: "elementary_upper" });
    const learnerId = learner.body.learner.id as string;

    const res = await post(app, "/api/v1/practice/submit", {
      learnerId,
      questionId: "q-num",
      answer: "26",
    });
    expect(res.body.correct).toBe(true);
    expect(res.body.verification).toBe("executable");
    expect(res.body.countedTowardMastery).toBe(true);
    expect(repo.getMastery(learnerId, NODE_A)?.evidenceN).toBe(1);
  });
});
