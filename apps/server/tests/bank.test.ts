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

/**
 * 补挂题型。
 *
 * 题型不是知识点：**知识点是大纲的骨架，题型是它在具体情境下的变体**。
 * 「年龄问题」不该出现在图谱里，它是「100以内加减法」加上
 * 「年龄差永远不变」这个情境——而那句话正是这类题唯一要讲的东西。
 * 实测 157 道题只有 6 道挂上了题型，抽取时那句"拿不准就省略"太保守了。
 */
describe("POST /api/v1/bank/rematch-types", () => {
  it("按题干补上题型，只补不改", async () => {
    const env = tempFixtureEnv([
      makeQuestion({
        id: "q1",
        stem: "今年爸爸年龄是儿子的5倍，15年后，爸爸年龄是儿子年龄的2倍，今年儿子几岁？",
        level: "elementary_upper",
        // 年龄问题声明它属于这个知识点——对得上才补挂（见下面那条）
        nodeIds: ["problem-solving-primary"],
      }),
      makeQuestion({ id: "q2", stem: "计算 12 + 13", problemTypeId: "planting-trees" }),
    ]);
    const app = createApp(env.state);
    const body = (await (
      await app.request("/api/v1/bank/rematch-types", { method: "POST" })
    ).json()) as { changed: number; changes: { id: string; to: string }[] };

    expect(body.changes.find((c) => c.id === "q1")?.to).toBe("age-problem");
    // 已经有题型的不动——那可能是人工核对过的
    expect(env.state.questions.byId.get("q2")!.problemTypeId).toBe("planting-trees");
  });

  /**
   * 只在本学段的题型里找。不筛的话「下面这幅图形中有多少个三角形？」
   * 会撞上高中的「解三角形与三角恒等」——实测 22 个匹配里 12 个是这么来的。
   * 关键词分数分不清"题里出现了三角形"和"这是一道解三角形的题"，学段能。
   */
  /**
   * 题型表自己声明了它属于哪些知识点，那就是现成的一致性校验。
   * 一开始没用它，代价立刻显形：10 道自动补挂里错了 2 道——
   * 「小精灵每小时做12朵纸花」（答案 6a+b）被判成平均数问题，
   * 「145.67 的百位是1」被判成和差问题。关键词分数只看字面撞了几个词。
   */
  it("题型声明的知识点与题目挂的对不上，就不补挂", async () => {
    const env = tempFixtureEnv([
      makeQuestion({
        id: "q1",
        stem: "今年爸爸年龄是儿子的5倍，15年后，爸爸年龄是儿子年龄的2倍，今年儿子几岁？",
        level: "elementary_upper",
        // 年龄问题声明的是 100以内加减法 / 问题解决与策略，这里挂的都不是
        nodeIds: ["decimal"],
      }),
    ]);
    const app = createApp(env.state);
    const body = (await (
      await app.request("/api/v1/bank/rematch-types", { method: "POST" })
    ).json()) as { changed: number };
    expect(body.changed).toBe(0);
    expect(env.state.questions.byId.get("q1")!.problemTypeId).toBeUndefined();
  });

  it("小学的题不会被判成高中题型", async () => {
    const env = tempFixtureEnv([
      makeQuestion({
        id: "q1",
        stem: "下面这幅图形中有多少个三角形？",
        level: "elementary_upper",
      }),
    ]);
    const app = createApp(env.state);
    await app.request("/api/v1/bank/rematch-types", { method: "POST" });
    const got = env.state.questions.byId.get("q1")!.problemTypeId;
    if (got) {
      const stage = env.state.knowledge.problemTypes.find((t) => t.id === got)!.stage;
      expect(stage).toBe("primary");
    }
  });
})

/**
 * 题库体检。
 *
 * 知识点与题型都是模型标的，标歪了不报错，只让诊断悄悄跑偏——
 * 一道小学数图形的题挂上高中「解三角形」，星图上就点亮一颗不该亮的星。
 * 这里只查不用读题就能判的那几类。
 */
describe("GET /api/v1/bank/audit", () => {
  it("挑出结构上对不上的地方", async () => {
    const env = tempFixtureEnv([
      makeQuestion({ id: "ok", stem: "正常题", nodeIds: [NODE_A] }),
      makeQuestion({ id: "cross", stem: "小学题挂了初中知识点", level: "elementary_upper", nodeIds: ["quadrilateral"] }),
      makeQuestion({ id: "ghost", stem: "知识点不存在", nodeIds: ["查无此点"] }),
      makeQuestion({ id: "mismatch", stem: "题型对不上", nodeIds: [NODE_A], problemTypeId: "age-problem" }),
    ]);
    const app = createApp(env.state);
    const body = (await (await app.request("/api/v1/bank/audit")).json()) as {
      total: number;
      byKind: Record<string, number>;
      findings: { kind: string; questionId: string; detail: string }[];
    };
    const kinds = (id: string) => body.findings.filter((f) => f.questionId === id).map((f) => f.kind);
    expect(kinds("ok")).toEqual([]);
    expect(kinds("cross")).toContain("知识点跨学段");
    expect(kinds("ghost")).toContain("知识点不存在");
    expect(kinds("mismatch")).toContain("题型与知识点对不上");
  });

  it("说清为什么可疑，而不只是标红", async () => {
    const env = tempFixtureEnv([
      makeQuestion({ id: "m", stem: "题型对不上", nodeIds: [NODE_A], problemTypeId: "age-problem" }),
    ]);
    const app = createApp(env.state);
    const body = (await (await app.request("/api/v1/bank/audit")).json()) as {
      findings: { detail: string }[];
    };
    // 要指出题型声明的是哪些知识点，人才知道该改哪一头
    expect(body.findings[0]!.detail).toContain("年龄问题");
    expect(body.findings[0]!.detail).toContain("声明属于");
  });
})

/**
 * 界面上只显示 id（add-sub-100、age-problem）没法用——家长抽检时
 * 得对着 id 猜那是什么。名字只有服务端手里有（图谱在这边），
 * 与其让前端再拉一份图谱回去自己映射，不如接口顺手带上。
 */
describe("下发中文名而不只是 id", () => {
  it("题库列表带知识点与题型的名字", async () => {
    const env = tempFixtureEnv([
      makeQuestion({
        id: "q1",
        stem: "年龄题",
        nodeIds: ["problem-solving-primary"],
        problemTypeId: "age-problem",
      }),
    ]);
    const app = createApp(env.state);
    const body = (await (await app.request("/api/v1/bank/questions")).json()) as {
      items: { nodeNames: string[]; problemTypeName?: string }[];
    };
    expect(body.items[0]!.nodeNames).toEqual(["问题解决与策略"]);
    expect(body.items[0]!.problemTypeName).toBe("年龄问题");
  });

  it("图谱里没有的 id 原样回显，不能显示成空", async () => {
    const env = tempFixtureEnv([makeQuestion({ id: "q1", stem: "题", nodeIds: ["查无此点"] })]);
    const app = createApp(env.state);
    const body = (await (await app.request("/api/v1/bank/questions")).json()) as {
      items: { nodeNames: string[] }[];
    };
    expect(body.items[0]!.nodeNames).toEqual(["查无此点"]);
  });
})
