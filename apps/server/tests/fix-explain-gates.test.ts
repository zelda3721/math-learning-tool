import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { sanitizeDiagnosisExplanation } from "../src/diagnosis.js";
import type { HintProvider } from "../src/hint.js";
import { knowledge, makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

/**
 * 对抗审查 A-02 / A-05 / A-07 的回归：讲解与归因对孩子的门。
 *
 * 全部走真实 HTTP + 真账户（authDisabled=false）：要证明的是"服务端拦没拦"，
 * 只有孩子会话的真请求说得清。
 */

function client(app: ReturnType<typeof createApp>) {
  let cookie = "";
  return {
    async call(method: string, url: string, body?: unknown) {
      const res = await app.request(url, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      const text = await res.text();
      let json: Record<string, any> = {};
      try {
        json = JSON.parse(text);
      } catch {
        // spec/html 产物不一定是 JSON 对象
      }
      return { status: res.status, body: json, text };
    },
  };
}

function makeAuthEnv(questions: ReturnType<typeof makeQuestion>[], overrides: Partial<AppState> = {}) {
  const env = tempFixtureEnv(questions);
  const db = openMemoryDb();
  const repo = new Repo(db);
  const state: AppState = { ...env.state, repo, auth: new AuthStore(db), authDisabled: false, ...overrides };
  return { ...env, repo, state, app: createApp(state) };
}

async function setupParentAndChild(env: ReturnType<typeof makeAuthEnv>) {
  const parent = client(env.app);
  await parent.call("POST", "/api/v1/auth/setup-parent", { username: "爸爸", password: "family-secret" });
  const child = client(env.app);
  await child.call("POST", "/api/v1/auth/register-child", {
    username: "小明",
    password: "child-secret",
    level: "elementary_upper",
  });
  const learnerId = env.repo.listLearners()[0]!.id;
  return { parent, child, learnerId };
}

/** 登记一份挂在某道题上的 SceneSpec 讲解（模拟「问一道题」顺手登记的整题讲解） */
function registerSpec(env: ReturnType<typeof makeAuthEnv>, specId: string, questionId: string | undefined) {
  const dir = path.join(env.dataDir, "specs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${specId}.json`), JSON.stringify({ secret: `整题解法-${specId}` }), "utf8");
  const id = `exp-${specId}`;
  env.repo.insertExplanation({
    id,
    questionId,
    focusNodeIds: [NODE_A],
    engineSessionId: "t",
    mode: "web",
    specUrl: `/api/v1/explain/specs/${specId}`,
    quality: "good",
    contractVersion: "t",
  });
  return id;
}

function registerHtml(env: ReturnType<typeof makeAuthEnv>, htmlId: string, questionId: string | undefined) {
  const dir = path.join(env.dataDir, "explanations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${htmlId}.html`), `<p>整题讲解 ${htmlId}</p>`, "utf8");
  env.repo.insertExplanation({
    id: `exp-${htmlId}`,
    questionId,
    focusNodeIds: [NODE_A],
    engineSessionId: "t",
    mode: "web_html",
    htmlUrl: `/api/v1/explain/html/${htmlId}`,
    quality: "good",
    contractVersion: "t",
  });
}

async function useAllHints(child: ReturnType<typeof client>, questionId: string, learnerId: string) {
  for (const level of [1, 2, 3]) {
    const res = await child.call("POST", "/api/v1/practice/hint", { questionId, level, learnerId });
    expect(res.status).toBe(200);
  }
}

describe("A-02 只带 focusNodeId 不能捞到别的题的整题讲解", () => {
  it("缓存命中挂在没走过的题上 → 当作未命中，响应里不出现那份产物", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "asked1", answer: "12" })]);
    const { child, parent } = await setupParentAndChild(env);
    registerSpec(env, "spec-asked1", "asked1");

    const res = await child.call("POST", "/api/v1/explain", { focusNodeId: NODE_A, mode: "web" });
    expect(res.status).toBe(200);
    expect(res.body.status).not.toBe("ready");
    expect(res.text).not.toContain("spec-asked1");

    // 家长照常命中（家长要能核对讲解）
    const p = await parent.call("POST", "/api/v1/explain", { focusNodeId: NODE_A, mode: "web" });
    expect(p.body.status).toBe("ready");
    expect(p.body.explanation.specUrl).toBe("/api/v1/explain/specs/spec-asked1");
  });

  it("纯节点讲解（不挂题）孩子照常命中", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "q1" })]);
    const { child } = await setupParentAndChild(env);
    registerSpec(env, "spec-node", undefined);
    const res = await child.call("POST", "/api/v1/explain", { focusNodeId: NODE_A, mode: "web" });
    expect(res.body.status).toBe("ready");
    expect(res.body.explanation.specUrl).toBe("/api/v1/explain/specs/spec-node");
  });

  it("孩子自己答对过那道题 → 节点命中放行", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "asked2", answer: "12" })]);
    const { child, learnerId } = await setupParentAndChild(env);
    registerSpec(env, "spec-asked2", "asked2");
    const ok = await child.call("POST", "/api/v1/practice/submit", { questionId: "asked2", answer: "12", learnerId });
    expect(ok.body.correct).toBe(true);
    const res = await child.call("POST", "/api/v1/explain", { focusNodeId: NODE_A, mode: "web" });
    expect(res.body.status).toBe("ready");
  });

  it("both 模式：别的题的 SceneSpec 不被当成已有退路复用，也不替那道题生成", async () => {
    const enginePayloads: Record<string, unknown>[] = [];
    const engineFetch = (async (_url: string, init?: RequestInit) => {
      enginePayloads.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({ status: "ok", plan_id: "p1", html: "<p>节点讲解</p>", html_gate: { ok: true } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const env = makeAuthEnv([makeQuestion({ id: "asked3", answer: "12" })], {
      contract: { contract_version: "t" } as unknown as AppState["contract"],
      engineFetch,
    });
    const { child } = await setupParentAndChild(env);
    registerSpec(env, "spec-asked3", "asked3");

    const res = await child.call("POST", "/api/v1/explain", { focusNodeId: NODE_A, mode: "both" });
    expect(res.status).toBe(202);
    const jobId = String(res.body.jobId);
    expect(env.repo.getExplainJob(jobId)?.questionId).toBeUndefined();
    for (let i = 0; i < 50 && env.repo.getExplainJob(jobId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // 没把 asked3 的 SceneSpec 当作已有那份：引擎被要求两份都生成（route=both，而非只补 html）
    expect(enginePayloads[0]?.route).toBe("both");
    const job = await child.call("GET", `/api/v1/explain/jobs/${jobId}`);
    expect(job.status).toBe(200);
    expect(job.text).not.toContain("spec-asked3");
  });
});

describe("A-02 产物直取：/specs /html /jobs /subtitles 按题把门", () => {
  it("/specs：挂题且没走过 → 403；家长 200；纯节点 200；孤儿产物对孩子 403；走过之后 200", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "s1", answer: "12" })]);
    const { child, parent, learnerId } = await setupParentAndChild(env);
    registerSpec(env, "spec-s1", "s1");
    registerSpec(env, "spec-pure", undefined);
    mkdirSync(path.join(env.dataDir, "specs"), { recursive: true });
    writeFileSync(path.join(env.dataDir, "specs", "orphan.json"), "{}", "utf8");

    const locked = await child.call("GET", "/api/v1/explain/specs/spec-s1");
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe("explain-locked");
    expect(locked.text).not.toContain("整题解法");

    expect((await parent.call("GET", "/api/v1/explain/specs/spec-s1")).status).toBe(200);
    expect((await child.call("GET", "/api/v1/explain/specs/spec-pure")).status).toBe(200);
    expect((await child.call("GET", "/api/v1/explain/specs/orphan")).status).toBe(403);
    expect((await parent.call("GET", "/api/v1/explain/specs/orphan")).status).toBe(200);

    await child.call("POST", "/api/v1/practice/submit", { questionId: "s1", answer: "12", learnerId });
    const open = await child.call("GET", "/api/v1/explain/specs/spec-s1");
    expect(open.status).toBe(200);
    expect(open.text).toContain("整题解法");
  });

  it("/html：挂题且没走过 → 403；家长 200", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "h1", answer: "12" })]);
    const { child, parent } = await setupParentAndChild(env);
    registerHtml(env, "html-h1", "h1");
    expect((await child.call("GET", "/api/v1/explain/html/html-h1")).status).toBe(403);
    expect((await parent.call("GET", "/api/v1/explain/html/html-h1")).status).toBe(200);
  });

  it("/jobs：任务挂的题没走过 → 403；家长 200；纯节点任务孩子 200", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "j1", answer: "12" })]);
    const { child, parent } = await setupParentAndChild(env);
    const expId = registerSpec(env, "spec-j1", "j1");
    const jobId = env.repo.createExplainJob({ questionId: "j1", focusNodeIds: [NODE_A], mode: "web" });
    env.repo.finishExplainJob(jobId, expId);
    const locked = await child.call("GET", `/api/v1/explain/jobs/${jobId}`);
    expect(locked.status).toBe(403);
    expect(locked.text).not.toContain("spec-j1");
    expect((await parent.call("GET", `/api/v1/explain/jobs/${jobId}`)).status).toBe(200);

    // 任务本身不挂题、交付的讲解却挂着题（旧数据）→ 也按讲解的题拦
    const looseJob = env.repo.createExplainJob({ focusNodeIds: [NODE_A], mode: "web" });
    env.repo.finishExplainJob(looseJob, expId);
    expect((await child.call("GET", `/api/v1/explain/jobs/${looseJob}`)).status).toBe(403);

    const pureExp = registerSpec(env, "spec-pure-job", undefined);
    const pureJob = env.repo.createExplainJob({ focusNodeIds: [NODE_A], mode: "web" });
    env.repo.finishExplainJob(pureJob, pureExp);
    expect((await child.call("GET", `/api/v1/explain/jobs/${pureJob}`)).status).toBe(200);
  });

  it("/subtitles：字幕挂在没走过的题的讲解上 → 403", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "v1", answer: "12" })]);
    const { child, parent } = await setupParentAndChild(env);
    env.repo.insertExplanation({
      id: "vid-v1",
      questionId: "v1",
      focusNodeIds: [NODE_A],
      engineSessionId: "t",
      mode: "video",
      videoUrl: "/media/x.mp4",
      subtitleUrl: "/api/v1/explain/subtitles/vid-v1",
      quality: "good",
      contractVersion: "t",
    });
    mkdirSync(path.join(env.dataDir, "subtitles"), { recursive: true });
    writeFileSync(path.join(env.dataDir, "subtitles", "vid-v1.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\n答案是 12\n", "utf8");
    expect((await child.call("GET", "/api/v1/explain/subtitles/vid-v1")).status).toBe(403);
    expect((await parent.call("GET", "/api/v1/explain/subtitles/vid-v1")).status).toBe(200);
  });
});

describe("A-05 三级提示用完还得真交过答案", () => {
  it("只点三下提示、一次没答 → 403；交一次（判定过的）错答 → 给讲", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "w1", answer: "7", analysis: "先求每份，再乘 3，答案是 7" })]);
    const { child, learnerId } = await setupParentAndChild(env);
    await useAllHints(child, "w1", learnerId);

    const noAttempt = await child.call("POST", "/api/v1/explain", { questionId: "w1", learnerId });
    expect(noAttempt.status).toBe(403);
    expect(noAttempt.body.code).toBe("explain-locked");
    expect(noAttempt.text).not.toContain("答案是 7");

    const wrong = await child.call("POST", "/api/v1/practice/submit", { questionId: "w1", answer: "3", learnerId });
    expect(wrong.body.correct).toBe(false);
    expect(wrong.body.needsReview).toBe(false);

    const after = await child.call("POST", "/api/v1/explain", { questionId: "w1", learnerId });
    expect(after.status).toBe(200);
    expect(after.body.fallback?.analysis).toContain("答案是 7");
  });

  it("只有待复核的作答、或家长试做的作答 → 仍然不算", async () => {
    const env = makeAuthEnv([makeQuestion({ id: "w2", answer: "7", analysis: "答案是 7" })]);
    const { child, learnerId } = await setupParentAndChild(env);
    await useAllHints(child, "w2", learnerId);
    const base = { learnerId, questionId: "w2", answer: "3", correct: false, hintLevelUsed: 3 as const, source: "daily" as const };
    env.repo.insertAttempt({ ...base, needsReview: true });
    expect((await child.call("POST", "/api/v1/explain", { questionId: "w2", learnerId })).status).toBe(403);
    env.repo.insertAttempt({ ...base, needsReview: false, actor: "parent" });
    expect((await child.call("POST", "/api/v1/explain", { questionId: "w2", learnerId })).status).toBe(403);
    env.repo.insertAttempt({ ...base, needsReview: false });
    expect((await child.call("POST", "/api/v1/explain", { questionId: "w2", learnerId })).status).toBe(200);
  });
});

describe("A-07 归因：答案不回给孩子，入口与界面路径一致", () => {
  it("sanitizeDiagnosisExplanation：剔答案、整句报答案换兜底、安检拦下换兜底", () => {
    const fb = "兜底句";
    const out = sanitizeDiagnosisExplanation("应该是 7 而不是 3，把加法当成乘法了", "7", fb);
    expect(out).not.toMatch(/(?<![\d.])7(?![\d.])/);
    expect(out).toContain("而不是 3");
    expect(sanitizeDiagnosisExplanation("7", "7", fb)).toBe(fb);
    expect(sanitizeDiagnosisExplanation(" 7 。", "7", fb)).toBe(fb);
    // 数值答案的其它写法也剔
    expect(sanitizeDiagnosisExplanation("正确结果是 7.0，孩子漏了进位", "7", fb)).not.toContain("7.0");
    expect(sanitizeDiagnosisExplanation("正确结果是 7，孩子漏了进位", "7.0", fb)).not.toMatch(/(?<![\d.])7(?![\d.])/);
    // 非字符串 / 空 → 兜底
    expect(sanitizeDiagnosisExplanation(42, "7", fb)).toBe(fb);
    expect(sanitizeDiagnosisExplanation(undefined, "7", fb)).toBe(fb);
    // 安检拦下 → 兜底
    expect(sanitizeDiagnosisExplanation("加我微信abcd1234细聊", "7", fb, () => true)).toBe(fb);
  });

  it("孩子答错一次就直接调归因 → 403；三级提示后的错答 → 200 且错因句里没有答案；家长不受限", async () => {
    const nodeWithPrereq = knowledge.graph.nodes.find((n) => n.prerequisites.length > 0)!;
    const llm: HintProvider = {
      async generate(prompt: string) {
        // 归因提示词里带着正确答案；模型一顺嘴就把它写进了错因句
        if (prompt.includes("候选薄弱知识点")) {
          return JSON.stringify({ surface: "calculation", explanation: "正确答案是 10，孩子算成了 3，漏了进位" });
        }
        return "先读题，圈出已知量。";
      },
    };
    const env = makeAuthEnv([makeQuestion({ id: "d1", nodeIds: [nodeWithPrereq.id], answer: "10" })], {
      hintProvider: llm,
    });
    const { child, parent, learnerId } = await setupParentAndChild(env);

    const first = await child.call("POST", "/api/v1/practice/submit", { questionId: "d1", answer: "3", learnerId });
    expect(first.body.correct).toBe(false);
    const early = await child.call("POST", `/api/v1/diagnosis/${first.body.attemptId}`, {});
    expect(early.status).toBe(403);
    expect(early.body.code).toBe("diagnosis-locked");

    // 家长核对不受这道门管（家长那边看到的错因句同样剔过答案）
    const byParent = await parent.call("POST", `/api/v1/diagnosis/${first.body.attemptId}`, {});
    expect(byParent.status).toBe(200);
    expect(byParent.body.explanation).not.toMatch(/(?<![\d.])10(?![\d.])/);

    await useAllHints(child, "d1", learnerId);
    const afterHints = await child.call("POST", "/api/v1/practice/submit", { questionId: "d1", answer: "3", learnerId });
    expect(afterHints.body.correct).toBe(false);
    const diag = await child.call("POST", `/api/v1/diagnosis/${afterHints.body.attemptId}`, {});
    expect(diag.status).toBe(200);
    expect(diag.body.explanation).toContain("漏了进位");
    expect(diag.body.explanation).not.toMatch(/(?<![\d.])10(?![\d.])/);
  });

  it("模型错因句命中输出安检 → 换成确定性兜底句（不透出原话）", async () => {
    const llm: HintProvider = {
      async generate(prompt: string) {
        if (prompt.includes("候选薄弱知识点")) {
          return JSON.stringify({ explanation: "不会就加我微信abcd1234问我" });
        }
        return "先读题。";
      },
    };
    const env = makeAuthEnv([makeQuestion({ id: "d2", answer: "10" })], { hintProvider: llm });
    const { child, learnerId } = await setupParentAndChild(env);
    await useAllHints(child, "d2", learnerId);
    const wrong = await child.call("POST", "/api/v1/practice/submit", { questionId: "d2", answer: "3", learnerId });
    const diag = await child.call("POST", `/api/v1/diagnosis/${wrong.body.attemptId}`, {});
    expect(diag.status).toBe(200);
    expect(diag.body.explanation).not.toContain("微信");
    expect(diag.body.explanation).toMatch(/根子可能在|暂定位到/);
  });
});
