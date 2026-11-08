import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";
import { chatBudgetReport, checkChatBudget, recordChatUsage, usedChatSecondsToday } from "../src/chatBudget.js";

/**
 * 每日对话时长：记的是**时长事件**而不是一个累计数字。
 *
 * 这样跨天不用半夜清零任务，家长也能看到"今天几点聊了多久"；
 * 删孩子数据时时长跟着一起走，不会留下对不上账的计数。
 */

function freshLearner(repo: ReturnType<typeof makeApp>["repo"], level = "elementary_upper") {
    return repo.createLearner("小测", level as never).id;
}

describe("记账", () => {
    it("每轮写一条事件，今天用掉多少秒由事件相加得出", () => {
        const { repo } = makeApp([]);
        const id = freshLearner(repo);
        expect(usedChatSecondsToday(repo, id)).toBe(0);

        recordChatUsage(repo, id, 90);
        recordChatUsage(repo, id, 30);
        expect(usedChatSecondsToday(repo, id)).toBe(120);
        // 0 秒的轮次不记：被拦下或没真正跑模型的请求不该占额度
        recordChatUsage(repo, id, 0);
        expect(repo.listEvents(id, "chat-usage")).toHaveLength(2);
    });

    it("只看今天的：昨天的时长不算数", () => {
        const { repo } = makeApp([]);
        const id = freshLearner(repo);
        recordChatUsage(repo, id, 600);
        const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
        expect(usedChatSecondsToday(repo, id, tomorrow)).toBe(0);
    });
});

describe("上限", () => {
    it("没设置时按学段给默认值，并说明这是默认", () => {
        const { repo } = makeApp([]);
        const primary = freshLearner(repo, "elementary_upper");
        const middle = freshLearner(repo, "middle");
        expect(chatBudgetReport(repo, primary).limitMinutes).toBe(20);
        expect(chatBudgetReport(repo, primary).source).toBe("default");
        expect(chatBudgetReport(repo, middle).limitMinutes).toBe(30);
    });

    it("家长设了就按家长的来；设 0 就是完全不许对话（而不是回落到默认）", () => {
        const { repo } = makeApp([]);
        const id = freshLearner(repo);
        repo.setLearnerPrefs(id, { dailyChatMinutes: 5 });
        expect(chatBudgetReport(repo, id)).toMatchObject({ limitMinutes: 5, source: "parent", allowed: true });

        repo.setLearnerPrefs(id, { dailyChatMinutes: 0 });
        expect(chatBudgetReport(repo, id)).toMatchObject({ limitMinutes: 0, allowed: false });
    });

    it("用完了就不许再开始，剩余时间不会变成负数", () => {
        const { repo } = makeApp([]);
        const id = freshLearner(repo);
        repo.setLearnerPrefs(id, { dailyChatMinutes: 2 });
        recordChatUsage(repo, id, 200);
        const budget = checkChatBudget(repo, id);
        expect(budget.allowed).toBe(false);
        expect(budget.remainingMinutes).toBe(0);
    });
});

describe("接口", () => {
    it("超时后探索对话直接 429，且把额度信息一起带回去", async () => {
        const { app, repo } = makeApp([]);
        const id = freshLearner(repo);
        repo.setLearnerPrefs(id, { dailyChatMinutes: 1 });
        recordChatUsage(repo, id, 120);

        const res = await app.request("/api/v1/explore/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ learnerId: id, messages: [{ role: "user", content: "讲讲分数" }] }),
        });

        expect(res.status).toBe(429);
        const body = (await res.json()) as { reply: string; budget: { limitMinutes: number } };
        expect(body.budget.limitMinutes).toBe(1);
        expect(body.reply).toContain("明天");
    });

    it("家长改时长，接口读回来一致", async () => {
        const { app, repo } = makeApp([]);
        const id = freshLearner(repo);

        const post = await app.request("/api/v1/parent/limits", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ learnerId: id, dailyChatMinutes: 45 }),
        });
        expect(post.status).toBe(200);
        expect((await post.json()) as { limitMinutes: number }).toMatchObject({ limitMinutes: 45, source: "parent" });

        const get = await app.request(`/api/v1/parent/limits?learnerId=${id}`);
        expect((await get.json()) as { limitMinutes: number }).toMatchObject({ limitMinutes: 45 });
    });

    it("家长能看到孩子被拦下过什么，但看不到原话", async () => {
        const { app, repo } = makeApp([]);
        const id = freshLearner(repo);

        await app.request("/api/v1/explore/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ learnerId: id, messages: [{ role: "user", content: "加个微信吧，我住阳光小区 3 号楼" }] }),
        });

        const res = await app.request(`/api/v1/parent/safety?learnerId=${id}`);
        const raw = await res.text();
        const body = JSON.parse(raw) as { events: { action: string; reason: string }[]; total: number };
        expect(body.total).toBe(1);
        expect(body.events[0]!.action).toBe("拦下");
        // 原话（住址）不该出现在家长页的响应里
        expect(raw).not.toContain("阳光小区");
    });
});
