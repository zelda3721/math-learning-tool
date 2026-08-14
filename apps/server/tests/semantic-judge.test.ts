/**
 * 语义判卷层。
 *
 * 规则堆了七层仍追不完人类写答案的花样——「田田27kg」和「27」是不是一回事
 * 是语义问题，交给模型。但纪律必须钉死：**只许判对，不许判错**。
 * 误判"对"孩子只是侥幸一次，误判"错"孩子会开始怀疑自己，代价差一个量级。
 */
import { describe, expect, it } from "vitest";
import { createAnswerJudge, judgePrompt, type JudgeChat } from "../src/semanticJudge.js";
import { makeApp, makeQuestion, NODE_A } from "./helpers.js";

const fakeChat = (reply: string | (() => string)): JudgeChat => ({
  async *chat() {
    yield { type: "text", text: typeof reply === "function" ? reply() : reply };
  },
});

const INPUT = {
  stem: "三人体重各多少？",
  reference: "27;13;26",
  student: "田田27,牛牛26,丁丁13",
};

describe("createAnswerJudge", () => {
  it("模型说 correct 就放行，带上理由", async () => {
    const judge = createAnswerJudge(fakeChat('{"verdict":"correct","why":"名字对应后数值一致"}'));
    expect(await judge(INPUT)).toEqual({ verdict: "correct", why: "名字对应后数值一致" });
  });

  it.each([
    ["wrong", '{"verdict":"wrong","why":"x"}'],
    ["unsure", '{"verdict":"unsure","why":"x"}'],
  ])("模型说 %s 原样返回——动作层决定怎么用", async (_v, reply) => {
    const judge = createAnswerJudge(fakeChat(reply));
    expect((await judge(INPUT))?.verdict).toBe(_v);
  });

  it("答非所问返回 null", async () => {
    const judge = createAnswerJudge(fakeChat("我觉得孩子答得挺好的。"));
    expect(await judge(INPUT)).toBeNull();
  });

  it("模型抛错返回 null——语义层坏了顶多退回交家长，绝不拦路", async () => {
    const boom: JudgeChat = {
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error("端点挂了");
      },
    };
    expect(await createAnswerJudge(boom)(INPUT)).toBeNull();
  });

  it("提示词把不对称写明白：拿不准就 unsure", () => {
    const p = judgePrompt(INPUT);
    expect(p).toContain("拿不准就 unsure");
    expect(p).toContain("田田27,牛牛26,丁丁13");
  });
});

describe("练习提交里的语义层", () => {
  const question = makeQuestion({
    id: "q1",
    nodeIds: [NODE_A],
    // 文字多值答案，规则判不出 → pending → 走语义层
    stem: "三种标本哪种最多？次多的呢？",
    answer: "植物；矿石",
    answerType: "steps",
  });

  async function submit(judgeReply: string | null) {
    const env = makeApp([question]);
    if (judgeReply !== null) {
      env.state.judge = async () => JSON.parse(judgeReply);
    }
    const learner = env.repo.createLearner("小明", "elementary_upper");
    const res = await env.app.request("/api/v1/practice/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        learnerId: learner.id,
        questionId: "q1",
        answer: "最多的是植物，然后是矿石",
      }),
    });
    return { env, learner, body: (await res.json()) as { correct: boolean; needsReview: boolean } };
  }

  it("规则 pending + 模型 correct → 判对、计掌握度、不打扰家长", async () => {
    const { env, learner, body } = await submit('{"verdict":"correct","why":"意思一致"}');
    expect(body.correct).toBe(true);
    expect(body.needsReview).toBe(false);
    expect(env.repo.allMastery(learner.id).length).toBeGreaterThan(0);
    // 放行要有痕迹，家长可审
    const events = env.repo["db"]
      .prepare("SELECT type FROM learner_events WHERE learner_id = ?")
      .all(learner.id) as { type: string }[];
    expect(events.some((e) => e.type === "ai_judge_accepted")).toBe(true);
  });

  it("模型说 wrong → 不判错，维持交家长（只许判对不许判错）", async () => {
    const { body } = await submit('{"verdict":"wrong","why":"x"}');
    expect(body.correct).toBe(false);
    expect(body.needsReview).toBe(true);
  });

  it("模型说 unsure → 同样交家长", async () => {
    const { body } = await submit('{"verdict":"unsure","why":"x"}');
    expect(body.needsReview).toBe(true);
  });

  it("没配判官时行为与从前完全一致", async () => {
    const { body } = await submit(null);
    expect(body.needsReview).toBe(true);
  });
});
