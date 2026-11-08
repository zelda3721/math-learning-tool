import { describe, expect, it } from "vitest";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { loadScenarios, summarizeSession } from "../src/speaking.js";
import { makeQuestion, tempFixtureEnv } from "./helpers.js";

/**
 * 英语口语对练（阶段 5）：三轮接口的契约。
 *
 * 链路（ASR → 导师 → TTS）在 compute-worker 里，这里用假的 engineFetch 顶掉，
 * 测的是网关这一层真正要保证的事：
 * ① 孩子说的话不进模型（安检）、模型的话不原样出去（输出侧）；
 * ② 不打分、不进掌握度，只留练习记录；
 * ③ 语音后端不在时诚实降级（能打字，或者明说不能开口），而不是装作在聊。
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

function makeEnv(opts: { ttsOk?: boolean; asrText?: string; asrStatus?: number; reply?: string } = {}) {
  const env = tempFixtureEnv([makeQuestion({ id: "q1", answer: "26" })]);
  const db = openMemoryDb();
  const state: AppState = {
    ...env.state,
    repo: new Repo(db),
    auth: new AuthStore(db),
    authDisabled: false,
    hintProvider: { generate: async () => opts.reply ?? "Nice! How old are you?" },
    engineFetch: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/tts")) {
        if (opts.ttsOk === false) return new Response("no tts", { status: 501 });
        return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { "content-type": "audio/wav" } });
      }
      if (url.endsWith("/api/v1/asr")) {
        if ((opts.asrStatus ?? 200) !== 200) return new Response("nope", { status: opts.asrStatus });
        return Response.json({ text: opts.asrText ?? "I'm nine years old", latency_ms: 120 });
      }
      void init;
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
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

describe("情景内容", () => {
  it("六个情景，每个都有角色、开场、目标与要练的表达", () => {
    const scenarios = loadScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
    for (const s of scenarios) {
      expect(s.aiRole.length).toBeGreaterThan(0);
      expect(s.opening).toMatch(/[A-Za-z]/);
      expect(s.expressions.length).toBeGreaterThan(0);
    }
  });

  it("小结只报「用到了哪些表达」，不打分", () => {
    const scenario = loadScenarios().find((s) => s.id === "a1-first-meeting")!;
    const summary = summarizeSession(scenario, [
      { role: "child", text: "my name is Lily. How about you?" },
      { role: "tutor", text: "I'm Sam." },
    ]);
    expect(summary.turns).toBe(1);
    expect(summary.used.some((e) => e.includes("My name is"))).toBe(true);
    expect(summary.tryNext.length).toBeGreaterThan(0);
    expect(summary).not.toHaveProperty("score");
  });
});

describe("口语接口", () => {
  it("开一次对练：给开场白和语音", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const res = await child.call("POST", "/api/v1/speaking/session", { learnerId });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.opening).toMatch(/[A-Za-z]/);
    expect(res.body.audio).toBeTruthy();
    expect(res.body.ttsAvailable).toBe(true);
  });

  it("一轮对话：录音识别 + 导师回复 + 语音，并记录延迟", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const opened = await child.call("POST", "/api/v1/speaking/session", { learnerId });
    const res = await child.call("POST", "/api/v1/speaking/turn", {
      learnerId,
      sessionId: opened.body.sessionId,
      audio: "data:audio/webm;base64,AAAA",
    });
    expect(res.status).toBe(200);
    expect(res.body.heard).toBe("I'm nine years old");
    expect(res.body.reply).toBe("Nice! How old are you?");
    expect(res.body.audio).toBeTruthy();
    expect(res.body.latency.asrMs).toBeGreaterThanOrEqual(0);

    // 记录里有一轮孩子、两轮导师（开场 + 这轮）
    const turns = env.state.repo.listSpeakingTurns(opened.body.sessionId);
    expect(turns.filter((t) => t.role === "child")).toHaveLength(1);
    expect(turns.filter((t) => t.role === "tutor")).toHaveLength(2);
  });

  it("孩子说的话过安检：拦下就不进模型，也不留原话", async () => {
    const env = makeEnv({ asrText: "What is your WeChat?" });
    const { child, learnerId } = await withChild(env);
    const opened = await child.call("POST", "/api/v1/speaking/session", { learnerId });
    const res = await child.call("POST", "/api/v1/speaking/turn", {
      learnerId,
      sessionId: opened.body.sessionId,
      audio: "data:audio/webm;base64,AAAA",
    });
    expect(res.status).toBe(200);
    expect(res.body.blocked).toBe(true);
    const turns = env.state.repo.listSpeakingTurns(opened.body.sessionId);
    const blocked = turns.filter((t) => t.role === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.text).toBe("");
    expect(turns.filter((t) => t.role === "child")).toHaveLength(0);
  });

  it("结束：给表达小结，事件里写清「不打分」", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const opened = await child.call("POST", "/api/v1/speaking/session", { learnerId });
    await child.call("POST", "/api/v1/speaking/turn", {
      learnerId,
      sessionId: opened.body.sessionId,
      text: "My name is Lily. How about you?",
    });
    const res = await child.call("POST", "/api/v1/speaking/end", { learnerId, sessionId: opened.body.sessionId });
    expect(res.status).toBe(200);
    expect(res.body.summary.turns).toBe(1);
    expect(res.body.summary.used.length).toBeGreaterThan(0);

    const events = env.state.repo.listEvents(learnerId, "speaking_session");
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { verification: string }).verification).toBe("ai_unverified");
  });

  it("没有语音识别后端：诚实 503 + 可读的话，而不是让孩子以为说错了", async () => {
    const env = makeEnv({ asrStatus: 501 });
    const { child, learnerId } = await withChild(env);
    const opened = await child.call("POST", "/api/v1/speaking/session", { learnerId });
    const res = await child.call("POST", "/api/v1/speaking/turn", {
      learnerId,
      sessionId: opened.body.sessionId,
      audio: "data:audio/webm;base64,AAAA",
    });
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain("语音识别");
  });

  it("TTS 挂了仍然能聊：有文字，没声音", async () => {
    const env = makeEnv({ ttsOk: false });
    const { child, learnerId } = await withChild(env);
    const opened = await child.call("POST", "/api/v1/speaking/session", { learnerId });
    expect(opened.body.audio).toBeNull();
    const res = await child.call("POST", "/api/v1/speaking/turn", {
      learnerId,
      sessionId: opened.body.sessionId,
      text: "Hello",
    });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBeTruthy();
    expect(res.body.audio).toBeNull();
  });

  it("时长用完 / 英语被关：入口就挡住", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    env.state.repo.appendEvent(learnerId, "active-usage", { seconds: 3600 });
    const over = await child.call("POST", "/api/v1/speaking/session", { learnerId });
    expect(over.status).toBe(429);

    const env2 = makeEnv();
    const second = await withChild(env2);
    env2.state.repo.setLearnerPrefs(second.learnerId, { modules: { english: false } });
    const closed = await second.child.call("POST", "/api/v1/speaking/session", { learnerId: second.learnerId });
    expect(closed.status).toBe(403);
  });

  it("孩子不能接管别人的会话", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const opened = await child.call("POST", "/api/v1/speaking/session", { learnerId });
    // 另一个孩子
    const other = client(env.app);
    await other.call("POST", "/api/v1/auth/register-child", {
      username: "小红",
      password: "child-secret",
      level: "elementary_upper",
    });
    const res = await other.call("POST", "/api/v1/speaking/turn", {
      sessionId: opened.body.sessionId,
      text: "hello",
    });
    expect(res.status).toBe(404);
  });

  it("家长端：默认只看轮次，打开「记录对话」才看得到内容；孩子打不开", async () => {
    const env = makeEnv();
    const { parent, child, learnerId } = await withChild(env);
    const opened = await child.call("POST", "/api/v1/speaking/session", { learnerId });
    await child.call("POST", "/api/v1/speaking/turn", {
      learnerId,
      sessionId: opened.body.sessionId,
      text: "My name is Lily.",
    });
    await child.call("POST", "/api/v1/speaking/end", { learnerId, sessionId: opened.body.sessionId });

    const closed = await parent.call("GET", `/api/v1/parent/speaking?learnerId=${learnerId}`);
    expect(closed.status).toBe(200);
    expect(closed.body.recording).toBe(false);
    expect(closed.body.sessions[0].turnCount).toBeGreaterThan(0);
    expect(closed.body.sessions[0].turns).toHaveLength(0);

    await parent.call("POST", "/api/v1/parent/transcripts/recording", { learnerId, enabled: true });
    const openedView = await parent.call("GET", `/api/v1/parent/speaking?learnerId=${learnerId}`);
    expect(openedView.body.recording).toBe(true);
    const texts = openedView.body.sessions[0].turns.map((t: { text: string }) => t.text).join(" ");
    expect(texts).toContain("My name is Lily");

    const forbidden = await child.call("GET", `/api/v1/parent/speaking?learnerId=${learnerId}`);
    expect(forbidden.status).toBe(403);
  });
});
