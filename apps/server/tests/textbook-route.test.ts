import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/**
 * 教材编译接口：只出提案、不写图谱。
 * 这条约束在接口层的体现：调用之后图谱节点数一个不变。
 */

async function post(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const PAGES = [
  { page: 1, text: "第一章 分数的意义\n把一个整体平均分成若干份，表示这样一份或几份的数叫分数。" },
  { page: 2, text: "分数的分母表示平均分成的份数，分子表示取了多少份。分数也可以看成除法。" },
];

describe("POST /api/v1/textbook/propose", () => {
  it("切出章节与知识点，并给出待确认的候选", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/propose", { title: "数学 五年级上", pages: PAGES });

    expect(res.status).toBe(200);
    expect(res.body.chapters.length).toBeGreaterThan(0);
    expect(res.body.items.length).toBeGreaterThan(0);
    // 每条都是待确认状态，且带候选
    for (const item of res.body.items) {
      expect(item.alignment.status).toBe("pending");
    }
    expect(res.body.note).toContain("图谱不会被直接修改");
  });

  it("图谱一个节点都不增加（只出提案，不写入）", async () => {
    const { app, state } = makeApp([]);
    const before = state.knowledge.graph.nodes.length;
    await post(app, "/api/v1/textbook/propose", { pages: PAGES });
    expect(state.knowledge.graph.nodes.length).toBe(before);
  });

  it("如实标出降级（这一版走离线兜底）", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/propose", { pages: PAGES });
    expect(res.body.degraded).toBe(true);
  });

  it("输入不合法 → 400 且说清要什么", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/propose", { pages: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("pages");
  });
});
