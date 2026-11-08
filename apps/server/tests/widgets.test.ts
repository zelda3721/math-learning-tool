import { describe, expect, it } from "vitest";
import { makeApp, makeQuestion, NODE_A, knowledge } from "./helpers.js";

/**
 * 组件的服务端契约：配哪个、记什么、以及"别信客户端"。
 *
 * 探索本身不判分，但**记录必须是真的**：家长回看时会看到"孩子拖到了第 99 格"
 * （而范围是 0–10），那种记录等于伪造了一段没发生过的探索。
 */

const widgetNode = knowledge.index.graph.nodes.find((n) => /面积|分数|时间|规律/.test(n.name));

describe("按节点配组件", () => {
  it("配得上的节点返回组件与收尾题", async () => {
    const node = widgetNode!;
    const { app, repo } = makeApp([makeQuestion({ id: "q1", nodeIds: [node.id], stem: "收尾题", answer: "1" })]);
    repo.createLearner("小测", "elementary_upper");
    const res = await app.request(`/api/v1/widgets/for-node?nodeId=${node.id}`);
    const body = (await res.json()) as { widget: { kind: string } | null; question: { stem: string } | null };
    expect(body.widget).toBeTruthy();
    expect(body.question?.stem).toBe("收尾题");
  });

  it("认不出的节点：说没有，而不是硬塞一个", async () => {
    const { app } = makeApp([]);
    const node = knowledge.index.graph.nodes.find((n) => !/面积|分数|时间|规律|数轴|方程|十进|分类|坐标|钱|价格/.test(n.name))!;
    const res = await app.request(`/api/v1/widgets/for-node?nodeId=${encodeURIComponent(node.id)}`);
    const body = (await res.json()) as { widget: unknown; note: string };
    expect(body.widget).toBeNull();
    expect(body.note).toContain("没有");
  });

  it("不存在的节点 404", async () => {
    const { app } = makeApp([]);
    const res = await app.request("/api/v1/widgets/for-node?nodeId=nope");
    expect(res.status).toBe(404);
  });
});

describe("记一次探索", () => {
  it("记下的是**服务端重放出来的**状态，不是客户端报的", async () => {
    const { app, repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    const res = await app.request("/api/v1/widgets/trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        learnerId: learner.id,
        nodeId: NODE_A,
        widget: "area_grid",
        actions: [{ op: "set", key: "width", value: 99 }],
        // 客户端谎报成一个不存在的状态
        finalState: { width: 99, height: 3 },
      }),
    });
    const body = (await res.json()) as { ok: boolean; finalState: { width: number } };
    expect(body.ok).toBe(true);
    // 控件上界是 10：重放把它夹回去了
    expect(body.finalState.width).toBe(10);

    const events = repo.listEvents(learner.id, "widget-use");
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as { mismatch: boolean; finalState: { width: number } };
    expect(payload.mismatch).toBe(true);
    expect(payload.finalState.width).toBe(10);
  });

  it("不存答案：事件里没有 answer 字段", async () => {
    const { app, repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    await app.request("/api/v1/widgets/trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        learnerId: learner.id,
        nodeId: NODE_A,
        widget: "money_change",
        actions: [{ op: "set", key: "price", value: 8 }],
        finalState: { price: 8, paid: 10 },
      }),
    });
    const recorded = JSON.stringify(repo.listEvents(learner.id, "widget-use"));
    expect(recorded).not.toContain("answer");
  });

  it("没有这个组件 404；参数不合法 400", async () => {
    const { app, repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    const bad = await app.request("/api/v1/widgets/trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId: learner.id, nodeId: NODE_A, widget: "不存在", actions: [], finalState: {} }),
    });
    expect(bad.status).toBe(404);

    const invalid = await app.request("/api/v1/widgets/trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId: learner.id }),
    });
    expect(invalid.status).toBe(400);
  });
});
