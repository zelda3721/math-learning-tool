import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatOptions, LlmStreamEvent } from "@mathtutor/llm-client";
import { createApp } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import {
  labRoutes,
  LAB_PROMPT_MAX,
  type LabBackendFactory,
  type LabClient,
} from "../src/lab.js";
import { makeQuestion, tempFixtureEnv } from "./helpers.js";

/**
 * AI 实验台的测试纪律：
 * - 一律不真连模型（假 client 注入，或者让真 client 在构造阶段就被拦下）；
 * - 只测这次新增的契约：参数校验、温度夹取、LOCAL_ONLY 与端点不可用时的
 *   可读错误、孩子 403、对比两栏。
 */

interface FakeCall {
  messages: ChatMessage[];
  opts?: ChatOptions;
}

/**
 * 假客户端：记录收到的 messages/opts，可指定回复文本、等待时长、抛错。
 * 同时统计"同时在飞的调用数"——对比模式必须是并行的，串行跑等于每次实验白等一倍。
 */
function makeFakeClient(behavior: {
  reply?: (opts?: ChatOptions) => string;
  delayMs?: number;
  failWith?: Error;
} = {}) {
  const calls: FakeCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const client: LabClient = {
    async *chat(messages, opts) {
      calls.push({ messages, opts });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs ?? 1));
        if (behavior.failWith) throw behavior.failWith;
        const text = behavior.reply?.(opts) ?? `回声：${String(messages[0]?.content ?? "")}`;
        yield { type: "text", text } satisfies LlmStreamEvent;
        yield {
          type: "done",
          finishReason: "stop",
          text,
          reasoning: "",
          toolCalls: [],
        } satisfies LlmStreamEvent;
      } finally {
        inFlight -= 1;
      }
    },
  };

  return { client, calls, maxInFlight: () => maxInFlight };
}

/** 直接把 lab 子路由挂在 /api/v1/lab 上（authDisabled=true，护栏放行） */
function makeLabApp(backendFactory?: LabBackendFactory) {
  const env = tempFixtureEnv([makeQuestion({ id: "labq1" })]);
  const app = new Hono();
  app.route("/api/v1/lab", labRoutes(env.state, backendFactory));
  return { app, state: env.state };
}

/** 带真实账户体系的应用：孩子 403 这类判定必须走真实中间件 */
function makeAuthApp() {
  const env = tempFixtureEnv([makeQuestion({ id: "labq2" })]);
  const db = openMemoryDb();
  const repo = new Repo(db);
  env.state.repo = repo;
  env.state.auth = new AuthStore(db);
  env.state.authDisabled = false;
  return { ...env, repo, app: createApp(env.state) };
}

function client(app: Hono) {
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
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

describe("实验台：参数校验", () => {
  it("提示词超过 2000 字 → 400，且这句话根本不会送到模型", async () => {
    const fake = makeFakeClient();
    const { app } = makeLabApp(() => ({ client: fake.client, model: "fake", localOnly: true }));

    const res = await client(app).call("POST", "/api/v1/lab/run", {
      prompt: "很长的提示词".repeat(400), // 2400 字
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain(String(LAB_PROMPT_MAX));
    expect(fake.calls).toHaveLength(0);
  });

  it("空提示词 → 400", async () => {
    const fake = makeFakeClient();
    const { app } = makeLabApp(() => ({ client: fake.client, model: "fake", localOnly: true }));
    const res = await client(app).call("POST", "/api/v1/lab/run", { prompt: "   " });
    expect(res.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("温度夹在 0–2；没传就用端点默认（undefined）", async () => {
    const fake = makeFakeClient();
    const { app } = makeLabApp(() => ({ client: fake.client, model: "fake", localOnly: true }));
    const c = client(app);

    await c.call("POST", "/api/v1/lab/run", { prompt: "你好", temperature: 5 });
    await c.call("POST", "/api/v1/lab/run", { prompt: "你好", temperature: -3 });
    await c.call("POST", "/api/v1/lab/run", { prompt: "你好" });

    expect(fake.calls.map((call) => call.opts?.temperature)).toEqual([2, 0, undefined]);
  });

  it("模型名去空白；空串按「没指定」处理（走端点默认模型）", async () => {
    const fake = makeFakeClient();
    const { app } = makeLabApp(() => ({ client: fake.client, model: "default-model", localOnly: true }));
    const c = client(app);

    const named = await c.call("POST", "/api/v1/lab/run", { prompt: "你好", model: "  qwen3:8b  " });
    expect(fake.calls[0]?.opts?.model).toBe("qwen3:8b");
    expect(named.body.model).toBe("qwen3:8b");

    const blank = await c.call("POST", "/api/v1/lab/run", { prompt: "你好", model: "   " });
    expect(fake.calls[1]?.opts?.model).toBeUndefined();
    expect(blank.body.model).toBe("default-model");
  });
});

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

describe("实验台：跑一次", () => {
  it("返回 reply / ms / model / localOnly，耗时是真实墙钟", async () => {
    const fake = makeFakeClient({ reply: () => "2", delayMs: 20 });
    const { app } = makeLabApp(() => ({ client: fake.client, model: "fake-main", localOnly: true }));

    const res = await client(app).call("POST", "/api/v1/lab/run", { prompt: "1+1=?", temperature: 0.3 });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("2");
    expect(res.body.model).toBe("fake-main");
    expect(res.body.localOnly).toBe(true);
    expect(res.body.temperature).toBe(0.3);
    expect(typeof res.body.ms).toBe("number");
    expect(res.body.ms).toBeGreaterThanOrEqual(15);
    expect(fake.calls[0]?.messages[0]?.content).toBe("1+1=?");
  });
});

// ---------------------------------------------------------------------------
// 失败路径：模型没配好 / 端点没起来 —— 都必须是可读的 502，不是 500 或未捕获异常
// ---------------------------------------------------------------------------

describe("实验台：模型不可用", () => {
  it("LOCAL_ONLY 下配了云端地址 → 502，且一个网络请求都没发出去", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("LLM_API_BASE", "https://api.example.com/v1");
    vi.stubEnv("LOCAL_ONLY", "1");

    // 不注入 factory：走真实的 createServerLlmClient，验的是硬约束本身
    const { app } = makeLabApp();
    const res = await client(app).call("POST", "/api/v1/lab/run", { prompt: "你好" });

    expect(res.status).toBe(502);
    expect(String(res.body.error)).toContain("LOCAL_ONLY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("端点没起来（连接被拒）→ 502 + 一句指向 LLM_API_BASE 的话", async () => {
    const fake = makeFakeClient({
      failWith: new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:1234"),
    });
    const { app } = makeLabApp(() => ({ client: fake.client, model: "fake", localOnly: true }));

    const res = await client(app).call("POST", "/api/v1/lab/run", { prompt: "你好" });
    expect(res.status).toBe(502);
    expect(String(res.body.error)).toContain("LLM_API_BASE");
    expect(res.body.ms).toBeTypeOf("number");
  });
});

// ---------------------------------------------------------------------------
// 对比模式
// ---------------------------------------------------------------------------

describe("实验台：对比", () => {
  it("返回两栏结构，各带温度/模型/耗时，并给出耗时差", async () => {
    const fake = makeFakeClient({
      reply: (opts) => `温度 ${opts?.temperature ?? "默认"} 的回答`,
      delayMs: 5,
    });
    const { app } = makeLabApp(() => ({ client: fake.client, model: "shared", localOnly: true }));

    const res = await client(app).call("POST", "/api/v1/lab/compare", {
      prompt: "用一句话解释分数",
      a: { temperature: 0.2 },
      b: { temperature: 1.4, model: "另一路模型" },
    });

    expect(res.status).toBe(200);
    expect(res.body.a.reply).toBe("温度 0.2 的回答");
    expect(res.body.b.reply).toBe("温度 1.4 的回答");
    expect(res.body.a.temperature).toBe(0.2);
    expect(res.body.b.temperature).toBe(1.4);
    expect(res.body.a.model).toBe("shared");
    expect(res.body.b.model).toBe("另一路模型");
    expect(res.body.deltaMs).toBe(res.body.b.ms - res.body.a.ms);
    // 两边拿到的是同一句提示词
    expect(fake.calls.map((call) => call.messages[0]?.content)).toEqual([
      "用一句话解释分数",
      "用一句话解释分数",
    ]);
  });

  it("两次调用是并行的（同时在飞 2 个），不是排队", async () => {
    const fake = makeFakeClient({ delayMs: 30 });
    const { app } = makeLabApp(() => ({ client: fake.client, model: "shared", localOnly: true }));

    await client(app).call("POST", "/api/v1/lab/compare", {
      prompt: "同一句话",
      a: { temperature: 0 },
      b: { temperature: 1 },
    });
    expect(fake.maxInFlight()).toBe(2);
  });

  it("只坏一边时，另一边照实交出来（不白花那一次调用）", async () => {
    let n = 0;
    const client_: LabClient = {
      async *chat(_messages, _opts) {
        n += 1;
        if (n === 1) throw new Error("boom");
        yield { type: "text", text: "这边活着" } satisfies LlmStreamEvent;
        yield { type: "done", finishReason: "stop", text: "这边活着", reasoning: "", toolCalls: [] } satisfies LlmStreamEvent;
      },
    };
    const { app } = makeLabApp(() => ({ client: client_, model: "shared", localOnly: true }));

    const res = await client(app).call("POST", "/api/v1/lab/compare", {
      prompt: "同一句话",
      a: { temperature: 0 },
      b: { temperature: 1 },
    });
    expect(res.status).toBe(200);
    const replies = [res.body.a, res.body.b];
    expect(replies.some((side) => side.error)).toBe(true);
    expect(replies.some((side) => side.reply === "这边活着")).toBe(true);
  });

  it("两边都失败 → 502", async () => {
    const fake = makeFakeClient({ failWith: new Error("fetch failed") });
    const { app } = makeLabApp(() => ({ client: fake.client, model: "shared", localOnly: true }));

    const res = await client(app).call("POST", "/api/v1/lab/compare", {
      prompt: "同一句话",
      a: {},
      b: {},
    });
    expect(res.status).toBe(502);
    expect(String(res.body.error)).toContain("两边都失败");
  });
});

// ---------------------------------------------------------------------------
// 权限：只给家长
// ---------------------------------------------------------------------------

describe("实验台：权限", () => {
  it("孩子访问 /run 与 /compare 都是 403；未登录是 401", async () => {
    const { app } = makeAuthApp();
    const parent = client(app);
    await parent.call("POST", "/api/v1/auth/setup-parent", { username: "家长", password: "family-pass" });

    const kid = client(app);
    const registered = await kid.call("POST", "/api/v1/auth/register-child", {
      username: "小实验",
      password: "1234",
      level: "elementary_upper",
    });
    expect(registered.status).toBe(201);

    expect((await kid.call("POST", "/api/v1/lab/run", { prompt: "你好" })).status).toBe(403);
    expect((await kid.call("POST", "/api/v1/lab/compare", { prompt: "你好", a: {}, b: {} })).status).toBe(403);

    const anon = client(app);
    expect((await anon.call("POST", "/api/v1/lab/run", { prompt: "你好" })).status).toBe(401);
  });

  it("家长能过护栏（超长提示词是 400 而不是 403），且确实挂在 /api/v1/lab 上", async () => {
    const { app } = makeAuthApp();
    const parent = client(app);
    await parent.call("POST", "/api/v1/auth/setup-parent", { username: "家长", password: "family-pass" });

    const res = await parent.call("POST", "/api/v1/lab/run", { prompt: "x".repeat(LAB_PROMPT_MAX + 1) });
    expect(res.status).toBe(400);
  });
});
