import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeApp, makeQuestion, tempFixtureEnv } from "./helpers.js";
import { withModuleGate } from "../src/modules.js";
import { createApp } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";

/**
 * 阶段 4「家长中心」的三件缺项：
 * 对话转写（默认关）、AI 判断抽查队列、模块开关。
 *
 * 这里全部走**真实路由**（只在组合根外面套一层模块闸，与 index.ts 同一函数），
 * 不连模型：把 LLM 端点指到一个必然拒绝连接的本地端口，探索对话落到兜底语，
 * 于是"记没记、记了什么"只取决于我们自己的代码。
 */

const savedBase = process.env.LLM_API_BASE;
const savedLocalOnly = process.env.LOCAL_ONLY;

beforeEach(() => {
  /*
   * 让探索对话**必然**落到兜底语，而不是真去连模型：
   * 给一个非本地端点 + LOCAL_ONLY 开着，LlmClient 在构造时就抛
   * （见 llm-client/client.ts），runExplore 直接返回固定引导语。
   * 这样"记没记、记了什么"只取决于我们自己的代码，也不会在别人的机器上
   * 打到真的 LM Studio。
   */
  process.env.LLM_API_BASE = "https://llm.example.com/v1";
  process.env.LOCAL_ONLY = "1";
});

afterEach(() => {
  if (savedBase === undefined) delete process.env.LLM_API_BASE;
  else process.env.LLM_API_BASE = savedBase;
  if (savedLocalOnly === undefined) delete process.env.LOCAL_ONLY;
  else process.env.LOCAL_ONLY = savedLocalOnly;
});

function setup() {
  const env = makeApp([makeQuestion({ id: "q1" })]);
  const learner = env.repo.createLearner("小转", "elementary_upper");
  // 与线上一致：组合根套一层模块闸
  const app = withModuleGate(env.app, env.state);
  return { ...env, learner, app };
}

function chat(app: ReturnType<typeof withModuleGate>, learnerId: string, content: string) {
  return app.request("/api/v1/explore/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ learnerId, messages: [{ role: "user", content }] }),
  });
}

function postJson(app: ReturnType<typeof withModuleGate>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 1) 对话转写
// ---------------------------------------------------------------------------

describe("对话转写（默认关）", () => {
  it("没开开关时，一轮对话下来库里一条都没有", async () => {
    const { app, learner, repo } = setup();

    const res = await chat(app, learner.id, "分数是什么意思");
    expect(res.status).toBe(200);

    const report = (await (await app.request(`/api/v1/parent/transcripts?learnerId=${learner.id}`)).json()) as {
      recording: boolean;
      turns: unknown[];
    };
    expect(report.recording).toBe(false);
    expect(report.turns).toHaveLength(0);
    // 不是"页面上不显示"，是**库里没有**——家长没开，就不该有这份记录
    expect(repo.listTranscripts(learner.id)).toHaveLength(0);
  });

  it("开启后逐轮落库；被拦下的那句只记「拦下了 + 原因」，原话不进库", async () => {
    const { app, learner, repo } = setup();
    await postJson(app, "/api/v1/parent/transcripts/recording", { learnerId: learner.id, enabled: true });

    await chat(app, learner.id, "分数是什么意思");
    await chat(app, learner.id, "那小数和分数有什么关系");

    const turns = repo.listTranscripts(learner.id);
    // 两轮 = 2 条 user + 2 条 assistant；历史重发不会把老话再记一遍
    expect(turns.filter((t) => t.role === "user").map((t) => t.content)).toEqual([
      "那小数和分数有什么关系",
      "分数是什么意思",
    ]);
    expect(turns.filter((t) => t.role === "assistant")).toHaveLength(2);

    // 被安全层拦下：只留标记与原因
    await chat(app, learner.id, "加个微信吧，我把身份证号也给你");
    const after = repo.listTranscripts(learner.id);
    const blocked = after.filter((t) => t.role === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.content).toBe("");
    expect(blocked[0]!.safetyReason).toContain("input");
    expect(blocked[0]!.safetyReason).toContain("contact-request");
    // 原话（联系方式、身份证号）一个字都不能落进转写
    const dumped = JSON.stringify(after);
    expect(dumped).not.toContain("微信");
    expect(dumped).not.toContain("身份证号");
    // 被拦下的那一轮也不该留下半条 assistant 记录
    expect(after.filter((t) => t.role === "assistant")).toHaveLength(2);
  });

  it("关掉之后不再写；再打开也不回溯关掉期间说的话", async () => {
    const { app, learner, repo } = setup();
    await postJson(app, "/api/v1/parent/transcripts/recording", { learnerId: learner.id, enabled: true });
    await chat(app, learner.id, "先问一句");
    const before = repo.listTranscripts(learner.id).length;
    expect(before).toBe(2);

    await postJson(app, "/api/v1/parent/transcripts/recording", { learnerId: learner.id, enabled: false });
    await chat(app, learner.id, "关掉之后说的话");
    expect(repo.listTranscripts(learner.id)).toHaveLength(before);

    await postJson(app, "/api/v1/parent/transcripts/recording", { learnerId: learner.id, enabled: true });
    const turns = repo.listTranscripts(learner.id);
    expect(turns).toHaveLength(before);
    expect(JSON.stringify(turns)).not.toContain("关掉之后说的话");
  });

  it("清空是真删：删完一条不剩，开关状态不变", async () => {
    const { app, learner, repo } = setup();
    await postJson(app, "/api/v1/parent/transcripts/recording", { learnerId: learner.id, enabled: true });
    await chat(app, learner.id, "分数是什么意思");
    expect(repo.listTranscripts(learner.id).length).toBe(2);

    const del = await app.request(`/api/v1/parent/transcripts?learnerId=${learner.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { removed: number }).removed).toBe(2);
    expect(repo.listTranscripts(learner.id)).toHaveLength(0);
    expect(repo.learnerPrefs(learner.id).recordTranscript).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2) AI 判断抽查队列
// ---------------------------------------------------------------------------

describe("AI 判断抽查队列", () => {
  function seedAttempts(repo: ReturnType<typeof setup>["repo"], learnerId: string) {
    const ai = repo.insertAttempt({
      learnerId,
      questionId: "q1",
      answer: "因为分子分母同时乘 2",
      correct: true,
      hintLevelUsed: 0,
      source: "daily",
      needsReview: false,
      verification: "ai_unverified",
    });
    const executable = repo.insertAttempt({
      learnerId,
      questionId: "q1",
      answer: "26",
      correct: true,
      hintLevelUsed: 0,
      source: "daily",
      needsReview: false,
      verification: "executable",
    });
    return { ai, executable };
  }

  it("只出 ai_unverified 的作答，并带上判卷依据", async () => {
    const { app, learner, repo } = setup();
    const { ai } = seedAttempts(repo, learner.id);
    repo.appendEvent(learner.id, "ai_judge_accepted", {
      questionId: "q1",
      student: "因为分子分母同时乘 2",
      why: "意思等价",
      verification: "ai_unverified",
    });

    const res = await app.request(`/api/v1/parent/ai-judgments?learnerId=${learner.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { attemptId: string; basis: string; studentAnswer: string; judgement: unknown }[];
      note?: string;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.attemptId).toBe(ai.id);
    expect(body.items[0]!.studentAnswer).toBe("因为分子分母同时乘 2");
    expect(body.items[0]!.basis).toBe("意思等价");
    expect(body.items[0]!.judgement).toBeNull();
  });

  it("「看过」写审计事件；「推翻」标需复核，**不动掌握度**", async () => {
    const { app, learner, repo } = setup();
    const { ai } = seedAttempts(repo, learner.id);

    const seen = await postJson(app, "/api/v1/parent/ai-judgment", { attemptId: ai.id, action: "reviewed" });
    expect(seen.status).toBe(200);

    const flip = await postJson(app, "/api/v1/parent/ai-judgment", {
      attemptId: ai.id,
      action: "overturn",
      note: "这个思路其实不对",
    });
    expect(flip.status).toBe(200);
    expect(((await flip.json()) as { needsReview: boolean }).needsReview).toBe(true);

    // 记为需复核：回到原来的判卷抽检队列，由家长自己给结论
    expect(repo.getAttempt(ai.id)?.needsReview).toBe(true);
    expect(repo.pendingReviewAttempts(learner.id).map((a) => a.id)).toContain(ai.id);

    // 宪法第 5 条：ai_unverified 不承重，推翻它也不能让它突然承重
    expect(repo.allMastery(learner.id)).toHaveLength(0);
    expect(repo.attemptedQuestionIds(learner.id).size).toBe(1);

    const audit = repo.listEvents(learner.id, "ai_judgment");
    expect(audit.map((e) => (e.payload as { action: string }).action)).toEqual(["reviewed", "overturn"]);

    // 队列里显示家长处理到哪一步了
    const list = (await (await app.request(`/api/v1/parent/ai-judgments?learnerId=${learner.id}`)).json()) as {
      items: { judgement: { action: string; note?: string } | null }[];
    };
    expect(list.items[0]!.judgement?.action).toBe("overturn");
    expect(list.items[0]!.judgement?.note).toBe("这个思路其实不对");
  });

  it("不是 AI 判断的作答走原来的抽检，这里 409", async () => {
    const { app, learner, repo } = setup();
    const { executable } = seedAttempts(repo, learner.id);
    const res = await postJson(app, "/api/v1/parent/ai-judgment", { attemptId: executable.id, action: "reviewed" });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 3) 模块开关
// ---------------------------------------------------------------------------

describe("模块开关", () => {
  it("默认全开，关掉哪个哪个入口就 403，恢复后可用", async () => {
    const { app, learner } = setup();

    const initial = (await (await app.request(`/api/v1/parent/modules?learnerId=${learner.id}`)).json()) as {
      modules: Record<string, boolean>;
      catalog: { id: string }[];
    };
    expect(initial.modules.explore).toBe(true);
    expect(initial.modules.classroom).toBe(true);
    // 清单随模块增加而变：这里只锁"默认全开"，不把模块数量写死
    expect(initial.catalog.map((m) => m.id)).toContain("explore");
    expect(initial.catalog.map((m) => m.id)).toContain("classroom");

    const off = await postJson(app, "/api/v1/parent/modules", {
      learnerId: learner.id,
      modules: { classroom: false },
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { modules: Record<string, boolean> }).modules).toMatchObject({
      explore: true,
      classroom: false,
    });

    const lessons = await app.request(`/api/v1/classroom/lessons?learnerId=${learner.id}`);
    expect(lessons.status).toBe(403);
    const lessonsBody = (await lessons.json()) as { error: string; code: string };
    // 孩子看到的是人话，不是「HTTP 403」
    expect(lessonsBody.error).toContain("家长");
    expect(lessonsBody.error).toContain("课堂");
    expect(lessonsBody.code).toBe("module-disabled");

    // 探索没关，照常能进
    expect((await chat(app, learner.id, "分数是什么意思")).status).toBe(200);

    await postJson(app, "/api/v1/parent/modules", { learnerId: learner.id, modules: { explore: false } });
    const blockedChat = await chat(app, learner.id, "分数是什么意思");
    expect(blockedChat.status).toBe(403);
    expect(((await blockedChat.json()) as { error: string }).error).toContain("探索对话");

    // 恢复：两边都回到可用
    await postJson(app, "/api/v1/parent/modules", {
      learnerId: learner.id,
      modules: { explore: true, classroom: true },
    });
    expect((await chat(app, learner.id, "分数是什么意思")).status).toBe(200);
    expect((await app.request(`/api/v1/classroom/lessons?learnerId=${learner.id}`)).status).toBe(200);
  });

  it("关掉的模块不牵连别的孩子的设置", async () => {
    const { app, repo } = setup();
    const a = repo.createLearner("甲", "elementary_upper");
    const b = repo.createLearner("乙", "elementary_upper");
    await postJson(app, "/api/v1/parent/modules", { learnerId: a.id, modules: { explore: false } });

    expect((await chat(app, a.id, "分数是什么意思")).status).toBe(403);
    expect((await chat(app, b.id, "分数是什么意思")).status).toBe(200);
  });

  it("未知模块名 422，不会静默写进去", async () => {
    const { app, learner } = setup();
    const res = await postJson(app, "/api/v1/parent/modules", {
      learnerId: learner.id,
      modules: { arcade: false },
    });
    expect(res.status).toBe(422);
  });

  /*
   * 带登录态的那条路：孩子的设置按**会话里签发的 learnerId** 判，
   * 请求里传别人的 id 也改不了结论（与 effectiveLearnerId 同一套纪律）。
   * 线上就是这条路，所以它得有一条测试。
   */
  it("孩子会话：课堂关掉后自己的请求 403，家长这边仍能看", async () => {
    const env = tempFixtureEnv([makeQuestion({ id: "q1" })]);
    const db = openMemoryDb();
    env.state.repo = new Repo(db);
    env.state.auth = new AuthStore(db);
    env.state.authDisabled = false;
    const app = withModuleGate(createApp(env.state), env.state);

    const cookies: Record<string, string> = {};
    const call = async (who: string, method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(cookies[who] ? { cookie: cookies[who] } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookies[who] = setCookie.split(";")[0]!;
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };

    await call("parent", "POST", "/api/v1/auth/setup-parent", { username: "妈妈", password: "family" });
    const kid = await call("kid", "POST", "/api/v1/auth/register-child", {
      username: "豆豆",
      password: "1234",
      level: "elementary_upper",
    });
    const learnerId = kid.body.user as { learnerId: string };

    expect((await call("kid", "GET", "/api/v1/classroom/lessons")).status).toBe(200);
    await call("parent", "POST", "/api/v1/parent/modules", {
      learnerId: learnerId.learnerId,
      modules: { classroom: false },
    });

    // 孩子会话下不需要（也不该）靠 query 传 learnerId
    const blocked = await call("kid", "GET", "/api/v1/classroom/lessons");
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.error)).toContain("家长");
    // 家长自己还能进（他要能看见自己关掉了什么）
    expect((await call("parent", "GET", "/api/v1/classroom/lessons")).status).toBe(200);

    // 转写接口仍是家长专属：孩子拿不到
    expect((await call("kid", "GET", `/api/v1/parent/transcripts?learnerId=${learnerId.learnerId}`)).status).toBe(403);
  });
});
