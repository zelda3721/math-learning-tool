import { describe, expect, it } from "vitest";
import { makeApp, makeQuestion, NODE_A } from "./helpers.js";
import { screenLearnerInput, screenModelOutput } from "../src/safety.js";

/**
 * 安全层接线：拦下的话**根本不进模型**，拦下的事**在家长那里看得见**。
 *
 * 这两个接口（探索对话、问一道题）在 e2e 里跑的是真栈，但这里不需要模型：
 * 被拦下的请求在调模型之前就返回了——这本身就是"没花冤枉钱"的证据。
 */

describe("安检本身", () => {
  it("放行的话不留痕、不改写", () => {
    const { repo } = makeApp([]);
    const decision = screenLearnerInput(repo, "L1", "分数的意义是什么");
    expect(decision.blocked).toBe(false);
    expect(decision.reply).toBe("");
  });

  it("拦下的话留一条 safety 事件，但**不存原话**", () => {
    const { state, repo } = makeApp([]);
    repo.createLearner("小测", "elementary_upper");
    const learnerId = repo.listLearners()[0]!.id;
    const before = repo.listEvents(learnerId).length;
    const decision = screenLearnerInput(repo, learnerId, "加个微信吧，我把身份证号也给你");
    expect(decision.blocked).toBe(true);
    expect(decision.reply).toContain("微信");

    const events = repo.listEvents(learnerId);
    expect(events.length).toBe(before + 1);
    const recorded = JSON.stringify(events[events.length - 1]);
    expect(recorded).toContain("safety");
    // 孩子的原话（尤其是身份证号这类）不该落进日志
    expect(recorded).not.toContain("身份证号");
    void state;
  });

  it("输出侧拦下时整段换成固定话术，不做半截改写", () => {
    const { repo } = makeApp([]);
    const decision = screenModelOutput(repo, "L1", "不会的话打 13812345678 找我");
    expect(decision.blocked).toBe(true);
    expect(decision.reply).not.toContain("13812345678");
    expect(decision.reply).toContain("回到题目");
  });
});

describe("探索对话", () => {
    it("要联系方式：模型一次都不会被调用，直接回固定话术", async () => {
        const { app } = makeApp([]);
        const res = await app.request("/api/v1/explore/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                learnerId: "L1",
                messages: [{ role: "user", content: "加个微信聊吧" }],
            }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { reply: string; toolTrace: unknown[]; safety?: { action: string } };
        expect(body.safety?.action).toBe("block");
        expect(body.reply).toContain("微信");
        expect(body.toolTrace).toEqual([]);
    });
});

describe("问一道题", () => {
    it("越界的输入 → 422 且不进解题链路", async () => {
        const { app, repo } = makeApp([]);
        repo.createLearner("小测", "elementary_upper");
        const learnerId = repo.listLearners()[0]!.id;
        const res = await app.request("/api/v1/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ learnerId, problem: "我不想活了，觉得没意思" }),
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: string; safety?: { reason: string } };
        expect(body.safety?.reason).toBe("unsafe-content");
        expect(body.error).toContain("爸爸妈妈");
    });

    it("正常题目照常进链路（不被安全层误伤）", async () => {
        const { app, repo } = makeApp([makeQuestion({ id: "q-perim", stem: "长方形长 8 厘米宽 5 厘米，周长是多少", answer: "26" })]);
        repo.createLearner("小测", "elementary_upper");
        const learnerId = repo.listLearners()[0]!.id;
        const res = await app.request("/api/v1/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ learnerId, problem: "长方形长 8 厘米宽 5 厘米，周长是多少", nodeIds: [NODE_A] }),
        });
        // 引擎离线时后续步骤可能返回别的状态；这里只要求"没有被安全层拦下"
        expect(res.status).not.toBe(422);
    });
});
