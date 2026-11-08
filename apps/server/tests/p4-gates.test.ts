import { describe, expect, it } from "vitest";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { makeHint } from "../src/hint.js";
import { knowledge, makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

/**
 * 阶段 4 的 DoD 两条硬要求：
 * ① 时长上限**前后端都生效**——课堂、英语、动手组件这些入口和练习共用同一个闸；
 * ② 模型输出**都过安全层**——提示、课堂旁白、解题步骤同样是"要说给孩子听的话"。
 */

function client(app: ReturnType<typeof createApp>) {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
  };
}

function makeEnv(overrides: Partial<AppState> = {}) {
  const env = tempFixtureEnv([makeQuestion({ id: "q1", nodeIds: [NODE_A], answer: "26" })]);
  const db = openMemoryDb();
  const repo = new Repo(db);
  const state: AppState = { ...env.state, repo, auth: new AuthStore(db), authDisabled: false, ...overrides };
  return { ...env, state, app: createApp(state) };
}

async function withChild(env: ReturnType<typeof makeEnv>) {
  const parent = client(env.app);
  await parent.call("POST", "/api/v1/auth/setup-parent", { username: "爸爸", password: "family-secret" });
  const child = client(env.app);
  await child.call("POST", "/api/v1/auth/register-child", {
    username: "小明",
    password: "child-secret",
    level: "elementary_upper",
  });
  return { parent, child, learnerId: env.state.repo.listLearners()[0]!.id };
}

describe("时长闸铺到所有入口", () => {
  it("课堂：时间用完 → 429，话是给孩子看的", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    env.state.repo.appendEvent(learnerId, "active-usage", { seconds: 3600 });
    const res = await child.call("GET", `/api/v1/classroom/lesson?nodeId=${NODE_A}`);
    expect(res.status).toBe(429);
    expect(String(res.body.error)).toContain("时间用完");
  });

  it("动手组件：时间用完 → 429", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    env.state.repo.appendEvent(learnerId, "active-usage", { seconds: 3600 });
    const res = await child.call("GET", `/api/v1/widgets/for-node?nodeId=${NODE_A}`);
    expect(res.status).toBe(429);
  });
});

describe("模型输出过安全层", () => {
  it("提示里有联系方式 → 退回静态提示，不把孩子引到外面去", async () => {
    const question = makeQuestion({ id: "h1", nodeIds: [NODE_A], answer: "26", stem: "小明有 26 个苹果" });
    const chatty = { generate: async () => "不会的话打我电话 13812345678，我教你" };
    const result = await makeHint(chatty, question, 1, undefined, (text) =>
      // 与 practice 路由里同一个安检：这里直接用规则层判断
      /1[3-9]\d{9}/.test(text),
    );
    expect(result.source).toBe("static");
    expect(result.hint).not.toContain("13812345678");
  });

  it("正常提示照常放行", async () => {
    const question = makeQuestion({ id: "h2", nodeIds: [NODE_A], answer: "26", stem: "小明有 26 个苹果" });
    const ok = { generate: async () => "先看看题目问的是什么，把已知的数量圈出来。" };
    const result = await makeHint(ok, question, 1, undefined, () => false);
    expect(result.source).toBe("llm");
  });
});

describe("安全层本身覆盖口语场景", () => {
  it("英语对话里的要联系方式与自伤都被拦", async () => {
    const { screenInput } = await import("@mathtutor/safety");
    expect(screenInput("What is your WeChat?").action).not.toBe("allow");
    expect(screenInput("I want to hurt myself").action).not.toBe("allow");
    // 点餐、问路这类正常对话要放行
    expect(screenInput("I'd like a cup of tea, please.").action).toBe("allow");
    void knowledge;
  });
});
