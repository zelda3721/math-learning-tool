import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { makeQuestion, tempFixtureEnv, NODE_A, NODE_B } from "./helpers.js";

function setup() {
  const env = tempFixtureEnv([
    makeQuestion({ id: "q1", nodeIds: [NODE_A], stem: "长8宽5的长方形周长是多少", answer: "26" }),
    makeQuestion({ id: "q2", nodeIds: [NODE_B], stem: "3/4 + 1/2 等于多少", answer: "1.25" }),
  ]);
  return { env, app: createApp(env.state) };
}
const json = async (res: Response) => (await res.json()) as any;

describe("题库管理：通过的题也要够得着", () => {
  it("列出全部题，不像抽检页那样只看待抽检的", async () => {
    const { app } = setup();
    const body = await json(await app.request("/api/v1/bank/questions"));
    expect(body.total).toBe(2);
    expect(body.items.map((q: { id: string }) => q.id).sort()).toEqual(["q1", "q2"]);
    // 每题带上所属批次，才谈得上整批撤回
    expect(body.items[0].batch).toBeTruthy();
  });

  it("按题干搜索、按知识点筛", async () => {
    const { app } = setup();
    const byText = await json(await app.request("/api/v1/bank/questions?q=长方形"));
    expect(byText.matched).toBe(1);
    expect(byText.items[0].id).toBe("q1");

    const byNode = await json(await app.request(`/api/v1/bank/questions?nodeId=${NODE_B}`));
    expect(byNode.items.map((q: { id: string }) => q.id)).toEqual(["q2"]);
  });

  it("给出各维度计数，一眼看出哪批导了多少、多少没抽检", async () => {
    const { app } = setup();
    const body = await json(await app.request("/api/v1/bank/questions"));
    expect(Object.values(body.facets.status).reduce((a: number, b) => a + Number(b), 0)).toBe(2);
    expect(Object.keys(body.facets.batch).length).toBeGreaterThan(0);
  });

  it("就地修改会落盘并重新加载，改动立刻对练习生效", async () => {
    const { app, env } = setup();
    const res = await app.request("/api/v1/bank/questions/q1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "28", difficulty: 4 }),
    });
    expect(res.status).toBe(200);
    const stored = env.state.questions.byId.get("q1")!;
    expect(stored.answer).toBe("28");
    expect(stored.difficulty).toBe(4);
  });

  it("改了题干或答案，内容指纹跟着变（否则查重会失效）", async () => {
    const { app, env } = setup();
    const before = env.state.questions.byId.get("q1")!.contentHash;
    await app.request("/api/v1/bank/questions/q1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stem: "长9宽5的长方形周长是多少" }),
    });
    expect(env.state.questions.byId.get("q1")!.contentHash).not.toBe(before);
  });

  it("挂不上的知识点直接拒绝——手改 JSON 绕得过，这条路绕不过", async () => {
    const { app } = setup();
    const res = await app.request("/api/v1/bank/questions/q1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeIds: ["根本不存在的节点"] }),
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toContain("图谱里没有");
  });

  it("改题干时配图要重新过门禁：题干变了，原来的图可能就对不上了", async () => {
    const { app, env } = setup();
    await app.request("/api/v1/bank/questions/q1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stem: "如图，∠B 是直角，AB = 3，BC = 4，求 AC。",
        figure: {
          points: [{ id: "A" }, { id: "B" }, { id: "C" }],
          constraints: [
            { kind: "length", from: "A", to: "B", value: 3 },
            { kind: "length", from: "B", to: "C", value: 4 },
            { kind: "right-angle", at: "B", from: "A", to: "C" },
          ],
        },
      }),
    });
    expect(env.state.questions.byId.get("q1")!.figure).toBeTruthy();

    // 再把题干改成不含这些数的，配图应当被判为对不上而丢弃
    const res = await app.request("/api/v1/bank/questions/q1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stem: "一个直角三角形，求斜边。" }),
    });
    const body = await json(res);
    expect(body.figureNote).toContain("题干没有的条件");
    expect(env.state.questions.byId.get("q1")!.figure).toBeUndefined();
  });

  it("figure 传 null 就是删掉配图", async () => {
    const { app, env } = setup();
    await app.request("/api/v1/bank/questions/q1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ figure: null }),
    });
    expect(env.state.questions.byId.get("q1")!.figure).toBeUndefined();
  });

  it("删除单题", async () => {
    const { app, env } = setup();
    const res = await app.request("/api/v1/bank/questions/q2", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(env.state.questions.byId.get("q2")).toBeUndefined();
    expect(env.state.questions.all).toHaveLength(1);
  });

  it("整批撤回要把批次名再打一遍——几百道题不能手滑删掉", async () => {
    const { app, env } = setup();
    const list = await json(await app.request("/api/v1/bank/questions"));
    const batch = list.items[0].batch as string;

    const noConfirm = await app.request(`/api/v1/bank/batches/${batch}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(noConfirm.status).toBe(400);
    expect(env.state.questions.all.length).toBe(2);

    const ok = await app.request(`/api/v1/bank/batches/${batch}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: batch }),
    });
    expect((await json(ok)).removed).toBe(2);
    expect(env.state.questions.all).toHaveLength(0);
  });

  it("不存在的题目返回 404 而不是静默成功", async () => {
    const { app } = setup();
    expect((await app.request("/api/v1/bank/questions/nope", { method: "DELETE" })).status).toBe(404);
    const patch = await app.request("/api/v1/bank/questions/nope", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ difficulty: 3 }),
    });
    expect(patch.status).toBe(404);
  });
})

/**
 * 重新归类：模型标的 answerType 不可信（实测 120 道里 19 道标错）。
 * 其中最伤的是纯数值题被标成 steps——那种题不判对错、不计掌握度、
 * 也进不了变式题池，孩子做对了只会看到"已交给家长确认"。
 */
describe("POST /api/v1/bank/reclassify", () => {
  it("把标错的类型改过来，并说清改了哪些", async () => {
    const env = tempFixtureEnv([
      makeQuestion({ id: "q1", answer: "44，20", answerType: "steps" }),
      makeQuestion({ id: "q2", answer: "乙和丁", answerType: "expression" }),
      makeQuestion({ id: "q3", answer: "26", answerType: "numeric" }),
    ]);
    const app = createApp(env.state);
    const res = await app.request("/api/v1/bank/reclassify", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changed: number;
      changes: { id: string; from: string; to: string }[];
    };
    expect(body.changed).toBe(2);
    expect(body.changes.find((c) => c.id === "q1")).toMatchObject({ from: "steps", to: "numeric" });
    expect(body.changes.find((c) => c.id === "q2")).toMatchObject({
      from: "expression",
      to: "steps",
    });
    // 改动落盘并 reload：内存里也是新的
    expect(env.state.questions.byId.get("q1")!.answerType).toBe("numeric");
  });

  it("已经对的题不动，也不白写一遍文件", async () => {
    const env = tempFixtureEnv([makeQuestion({ id: "q1", answer: "26", answerType: "numeric" })]);
    const app = createApp(env.state);
    const body = (await (await app.request("/api/v1/bank/reclassify", { method: "POST" })).json()) as {
      changed: number;
    };
    expect(body.changed).toBe(0);
  });
});
