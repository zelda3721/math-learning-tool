import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AuthStore, CHILD_LIMIT } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { makeQuestion, tempFixtureEnv } from "./helpers.js";

function makeAuthApp() {
  const env = tempFixtureEnv([makeQuestion({ id: "aq1", answer: "7" })]);
  const db = openMemoryDb();
  const repo = new Repo(db);
  env.state.repo = repo;
  env.state.auth = new AuthStore(db);
  env.state.authDisabled = false;
  return { ...env, repo, app: createApp(env.state) };
}

/** cookie 会话简易客户端 */
function client(app: ReturnType<typeof makeAuthApp>["app"]) {
  let cookie = "";
  return {
    async call(method: string, path: string, body?: unknown) {
      const res = await app.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    reset() {
      cookie = "";
    },
  };
}

describe("auth flow", () => {
  it("unauthenticated requests are rejected; auth endpoints stay open", async () => {
    const { app } = makeAuthApp();
    const c = client(app);
    expect((await c.call("POST", "/api/v1/practice/today", { learnerId: "x" })).status).toBe(401);
    expect((await c.call("GET", "/api/v1/atlas")).status).toBe(401);
    const state = await c.call("GET", "/api/v1/auth/state");
    expect(state.status).toBe(200);
    expect(state.body.parentExists).toBe(false);
    expect(state.body.childLimit).toBe(CHILD_LIMIT);
  });

  it("parent setup once; child self-registration capped at 5", async () => {
    const { app } = makeAuthApp();
    const parent = client(app);
    const setup = await parent.call("POST", "/api/v1/auth/setup-parent", {
      username: "爸爸",
      password: "family-secret",
    });
    expect(setup.status).toBe(201);
    expect(setup.body.user.role).toBe("parent");
    // 二次初始化被拒
    expect(
      (await parent.call("POST", "/api/v1/auth/setup-parent", { username: "x", password: "yyyy" })).status,
    ).toBe(409);

    // 5 个孩子注册成功，第 6 个被拒
    for (let i = 1; i <= 5; i++) {
      const kid = client(app);
      const res = await kid.call("POST", "/api/v1/auth/register-child", {
        username: `孩子${i}`,
        password: "1234",
        level: "elementary_upper",
      });
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe("child");
      expect(res.body.user.learnerId).toBeTruthy();
    }
    const sixth = client(app);
    const rejected = await sixth.call("POST", "/api/v1/auth/register-child", {
      username: "孩子6",
      password: "1234",
      level: "elementary_upper",
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toContain("名额已满");
  });

  it("child sessions are hard-scoped to their own learner", async () => {
    const { app, repo } = makeAuthApp();
    const parent = client(app);
    await parent.call("POST", "/api/v1/auth/setup-parent", { username: "妈妈", password: "family" });

    const kidA = client(app);
    const a = await kidA.call("POST", "/api/v1/auth/register-child", {
      username: "小明", password: "1234", level: "elementary_upper",
    });
    const kidB = client(app);
    const b = await kidB.call("POST", "/api/v1/auth/register-child", {
      username: "小红", password: "1234", level: "elementary_upper",
    });
    const learnerA = a.body.user.learnerId as string;
    const learnerB = b.body.user.learnerId as string;

    // 小明冒充小红请求 today → 服务端强制回自己的 learner（做题写入 A 名下）
    const today = await kidA.call("POST", "/api/v1/practice/today", { learnerId: learnerB });
    expect(today.status).toBe(200);
    await kidA.call("POST", "/api/v1/practice/submit", {
      learnerId: learnerB, // 恶意传 B
      questionId: "aq1",
      answer: "7",
    });
    expect(repo.attemptedQuestionIds(learnerA).has("aq1")).toBe(true);
    expect(repo.attemptedQuestionIds(learnerB).has("aq1")).toBe(false);

    // 错题列表同理：小明查 B 的 learnerId，返回的是 A 自己的（空）列表
    const mistakes = await kidA.call("GET", `/api/v1/diagnosis/mistakes?learnerId=${learnerB}`);
    expect(mistakes.status).toBe(200);
    expect(mistakes.body.mistakes).toEqual([]);

    // 家长面孩子禁入
    expect((await kidA.call("GET", `/api/v1/parent/summary?learnerId=${learnerA}`)).status).toBe(403);
    expect((await kidA.call("POST", "/api/v1/ingest/upload", { kind: "text", content: "1. x" })).status).toBe(403);
    expect((await kidA.call("GET", "/api/v1/auth/children")).status).toBe(403);

    // 家长可以看任意孩子
    const summary = await parent.call("GET", `/api/v1/parent/summary?learnerId=${learnerA}`);
    expect(summary.status).toBe(200);
    const children = await parent.call("GET", "/api/v1/auth/children");
    expect(children.body.children.length).toBe(2);
  });

  it("login/logout lifecycle and parent child management", async () => {
    const { app } = makeAuthApp();
    const parent = client(app);
    await parent.call("POST", "/api/v1/auth/setup-parent", { username: "家长", password: "secret-1" });
    const kid = client(app);
    await kid.call("POST", "/api/v1/auth/register-child", {
      username: "豆豆", password: "1234", level: "elementary_lower",
    });

    // 登出后失效
    await kid.call("POST", "/api/v1/auth/logout");
    kid.reset();
    expect((await kid.call("POST", "/api/v1/practice/today", { learnerId: "x" })).status).toBe(401);

    // 密码登录（错密码拒绝）
    expect((await kid.call("POST", "/api/v1/auth/login", { username: "豆豆", password: "0000" })).status).toBe(401);
    const login = await kid.call("POST", "/api/v1/auth/login", { username: "豆豆", password: "1234" });
    expect(login.status).toBe(200);

    // 家长重置密码 → 旧会话吊销、新密码可登录
    const children = await parent.call("GET", "/api/v1/auth/children");
    const childId = children.body.children[0].id as string;
    await parent.call("POST", `/api/v1/auth/children/${childId}/reset-password`, { password: "5678" });
    expect((await kid.call("POST", "/api/v1/practice/today", { learnerId: "x" })).status).toBe(401);
    kid.reset();
    expect((await kid.call("POST", "/api/v1/auth/login", { username: "豆豆", password: "5678" })).status).toBe(200);

    // 删除孩子账号 → 名额释放，learner 数据保留
    const del = await parent.call("DELETE", `/api/v1/auth/children/${childId}`);
    expect(del.status).toBe(200);
    expect(del.body.learnerKept).toBeTruthy();
    const after = await parent.call("GET", "/api/v1/auth/state");
    expect(after.body.childCount).toBe(0);
  });
});
