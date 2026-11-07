import { describe, expect, it } from "vitest";
import { makeApp, makeQuestion } from "./helpers.js";
import { checkChatBudget, recordActiveUsage, usedChatSecondsToday } from "../src/chatBudget.js";
import { BREAK_AFTER_MINUTES, shouldSuggestBreak } from "@mathtutor/safety";

/**
 * 使用时长：记的是**孩子用了多久**，不是模型跑了多久。
 *
 * 这条线原来记的是服务端等模型的秒数——孩子盯一小时屏幕可能只记几十秒，
 * 上限形同虚设；模型一慢，孩子反而"被用掉了时间"。现在由前端活跃心跳上报，
 * 服务端按真实流逝封顶。
 */

function learner(repo: ReturnType<typeof makeApp>["repo"]) {
  return repo.createLearner("小测", "elementary_upper").id;
}

describe("心跳记账", () => {
  it("报多少记多少（在真实流逝之内）", () => {
    const { repo } = makeApp([]);
    const id = learner(repo);
    const t0 = Date.now();
    recordActiveUsage(repo, id, 60, t0);
    recordActiveUsage(repo, id, 60, t0 + 61_000);
    expect(usedChatSecondsToday(repo, id)).toBe(120);
  });

  it("报得比真实流逝多：按流逝封顶，不采信", () => {
    const { repo } = makeApp([]);
    const id = learner(repo);
    const t0 = Date.now();
    recordActiveUsage(repo, id, 5, t0);
    const second = recordActiveUsage(repo, id, 3_600, t0 + 10_000);
    expect(second.rejected).toBe(true);
    // 10 秒真实流逝，最多按 ~25 秒算，绝不可能是 3600
    expect(usedChatSecondsToday(repo, id)).toBeLessThan(60);
  });

  it("单条最多 300 秒：一次补报不能把半天算成一天", () => {
    const { repo } = makeApp([]);
    const id = learner(repo);
    const t0 = Date.now();
    recordActiveUsage(repo, id, 10, t0);
    const clamped = recordActiveUsage(repo, id, 3_600, t0 + 10 * 60_000);
    expect(clamped.recorded).toBeLessThanOrEqual(300);
  });

  it("旧口径的 chat-usage 仍然算进今天（升级当天不该凭空清零）", () => {
    const { repo } = makeApp([]);
    const id = learner(repo);
    repo.appendEvent(id, "chat-usage", { seconds: 30 });
    recordActiveUsage(repo, id, 20);
    expect(usedChatSecondsToday(repo, id)).toBe(50);
  });
});

describe("闸在入口生效", () => {
  it("用完了：练习入口直接 429，并说清还要等多久（明天）", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "q1" })]);
    const id = learner(repo);
    repo.setLearnerPrefs(id, { dailyChatMinutes: 0 });

    const res = await app.request("/api/v1/practice/today", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId: id }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; budget: { allowed: boolean } };
    expect(body.budget.allowed).toBe(false);
    expect(body.error).toContain("今天的时间用完了");
  });

  it("今天还剩多少：接口给前端显示用", async () => {
    const { app, repo } = makeApp([]);
    const id = learner(repo);
    recordActiveUsage(repo, id, 60);
    const res = await app.request(`/api/v1/usage/today?learnerId=${id}`);
    const body = (await res.json()) as { usedMinutes: number; limitMinutes: number; remainingMinutes: number };
    expect(body.usedMinutes).toBe(1);
    expect(body.remainingMinutes).toBe(body.limitMinutes - 1);
    expect(checkChatBudget(repo, id).allowed).toBe(true);
  });

  it("连续用太久给休息提醒", async () => {
    const { app, repo } = makeApp([]);
    const id = learner(repo);
    const res = await app.request("/api/v1/usage/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId: id, seconds: 60, continuousMinutes: BREAK_AFTER_MINUTES }),
    });
    const body = (await res.json()) as { breakDue: boolean };
    expect(body.breakDue).toBe(true);
    expect(shouldSuggestBreak(BREAK_AFTER_MINUTES - 1)).toBe(false);
  });
});
