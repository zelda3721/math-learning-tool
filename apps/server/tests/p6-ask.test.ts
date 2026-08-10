import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import type { EngineContract } from "@mathtutor/schema";
import { createApp } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { classifyAnswer } from "../src/ask.js";
import { leaksAnswer } from "../src/hint.js";
import { makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

/**
 * P6 自由提问：题库外的题也必须走练习纪律
 * （先作答 → 判卷 → L1→L3 提示 → 仍错才讲解 → 变式点亮），而不是答案机器。
 */

const CONTRACT: EngineContract = {
  contract_version: "open_world_v4",
  tools: [],
  event_types: [],
  artifact_url_base: "/api/v1/media",
};

const GOOD_SPEC = {
  visual_thesis: "周长是四条边的总长",
  visual_objects: [{ id: "rect", primitive: "rectangle", params: { width: 8, height: 5 } }],
  scenes: [{ role: "setup", actions: [{ op: "appear", target: "rect" }], teaching_line: "看这个长方形" }],
  grounding_source: "verified_solution_arithmetic",
};

const PROBLEM = "一个长方形的长是8厘米，宽是5厘米，它的周长是多少厘米？";

/** mock 引擎 plan-only：返回已验证的 solution_answer / solution_steps / scene_spec */
function mockPlan(opts: {
  answer?: string;
  steps?: string[];
  spec?: unknown;
  status?: string;
  error?: string;
} = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("/api/v1/plan")) throw new Error(`unexpected url ${u}`);
    calls.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(
      JSON.stringify({
        status: opts.status ?? "ok",
        plan_id: "plan-ask-1",
        scene_spec: opts.spec === undefined ? GOOD_SPEC : opts.spec,
        solution_answer: opts.answer === undefined ? "26" : opts.answer,
        solution_steps: opts.steps ?? ["长+宽 = 8+5 = 13", "周长 = 13 × 2 = 26（厘米）"],
        error: opts.error,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeAskApp(engineFetch: typeof fetch, opts: { offline?: boolean; leakyHint?: boolean } = {}) {
  const env = tempFixtureEnv([makeQuestion({ id: "bank1", nodeIds: [NODE_A], stem: "题库原有题", answer: "7" })]);
  env.state.contract = opts.offline ? null : CONTRACT;
  env.state.engineFetch = engineFetch;
  if (opts.leakyHint) {
    // 故意泄漏答案的 LLM：程序端泄漏检测必须拦下并退回静态提示
    env.state.hintProvider = { generate: async () => "很简单，答案就是 26 厘米，直接写上去吧。" };
  }
  return { app: createApp(env.state), ...env };
}

async function post(app: ReturnType<typeof makeAskApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function waitAskJob(app: ReturnType<typeof makeAskApp>["app"], jobId: string) {
  for (let i = 0; i < 50; i++) {
    const res = await app.request(`/api/v1/ask/jobs/${jobId}`);
    const body = (await res.json()) as Record<string, any>;
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("ask job never settled");
}

describe("ask: 题库外的题走完整练习纪律", () => {
  it("提问 → 临时题目（不下发答案）→ 判错 → 提示不泄漏 → 判对 → 入库进家长抽检", async () => {
    const { app, repo, store } = makeAskApp(mockPlan().impl, { leakyHint: true });
    const learner = repo.createLearner("小明", "elementary_upper");

    const asked = await post(app, "/api/v1/ask", { learnerId: learner.id, problem: PROBLEM });
    expect(asked.status).toBe(202);
    expect(asked.body.status).toBe("generating");
    expect(asked.body.isNew).toBe(true);

    const job = await waitAskJob(app, asked.body.jobId);
    expect(job.status).toBe("done");
    const question = job.question;
    expect(question.id).toMatch(/^free-/);
    expect(question.stem).toBe(PROBLEM);
    expect(question.answerType).toBe("numeric");
    // 不喂答案：题目视图里绝不能出现答案/解析
    expect(question.answer).toBeUndefined();
    expect(question.analysis).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("26");

    // ① 先自己作答 → 答错
    const wrong = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id,
      questionId: question.id,
      answer: "20",
      source: "daily",
    });
    expect(wrong.status).toBe(200);
    expect(wrong.body.correct).toBe(false);
    expect(wrong.body.method).toBe("numeric");
    expect(wrong.body.hintAvailable).toBe(true);

    // ② 提示阶梯 L1→L3：一条都不许出现答案
    const stored = store.byId.get(question.id)!;
    for (const level of [1, 2, 3]) {
      const hint = await post(app, "/api/v1/practice/hint", {
        learnerId: learner.id,
        questionId: question.id,
        level,
        lastWrongAnswer: "20",
      });
      expect(hint.status).toBe(200);
      expect(hint.body.hint.length).toBeGreaterThan(0);
      expect(leaksAnswer(hint.body.hint, stored)).toBe(false);
      expect(hint.body.hint).not.toContain("26");
      expect(hint.body.source).toBe("static"); // 泄漏的 LLM 提示被拦下
    }

    // ③ 答对
    const right = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id,
      questionId: question.id,
      answer: "26 厘米",
      hintLevelUsed: 3,
      source: "daily",
    });
    expect(right.body.correct).toBe(true);

    // ④ 入库：孩子问过的题变成他的题库，且必须进家长抽检队列
    expect(stored.status).toBe("extracted");
    expect(stored.answer).toBe("26");
    expect(stored.source.role).toBe("student");
    expect(stored.analysis).toContain("周长");
    const bankView = await (await app.request("/api/v1/ingest/questions?status=extracted")).json();
    expect(bankView.items.some((q: { id: string }) => q.id === question.id)).toBe(true);
  });

  it("讲解命中 plan 阶段的 scene_spec（秒回，不再调引擎）；变式/诊断通路在临时题上可用", async () => {
    const { app, repo } = makeAskApp(mockPlan().impl);
    const learner = repo.createLearner("小红", "elementary_upper");
    const asked = await post(app, "/api/v1/ask", { learnerId: learner.id, problem: PROBLEM });
    const job = await waitAskJob(app, asked.body.jobId);
    const questionId = job.question.id as string;

    // 讲解：ask 阶段已登记 web 讲解 → status ready
    const explain = await post(app, "/api/v1/explain", { learnerId: learner.id, questionId });
    expect(explain.status).toBe(200);
    expect(explain.body.status).toBe("ready");
    expect(explain.body.explanation.specUrl).toMatch(/^\/api\/v1\/explain\/specs\//);
    const specRes = await app.request(explain.body.explanation.specUrl);
    expect(specRes.status).toBe(200);
    expect((await specRes.json()).visual_thesis).toBe(GOOD_SPEC.visual_thesis);

    // 诊断：错误作答可归因（临时题在题库里，attempt 可查）
    const wrong = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id,
      questionId,
      answer: "20",
      source: "daily",
    });
    const diag = await post(app, `/api/v1/diagnosis/${wrong.body.attemptId}`, {});
    expect(diag.status).toBe(200);
    expect(diag.body.rootNodeId).toBeTruthy();

    // 变式门：端点在临时题上不 404（有变式给变式，没有就排进复习队列）
    const variant = await post(app, "/api/v1/practice/variant", { learnerId: learner.id, questionId });
    expect(variant.status).toBe(200);
    expect(["bank", "generated", "none"]).toContain(variant.body.kind);
  });

  it("同一道题再问命中缓存，不重复建题也不重复调引擎", async () => {
    const engine = mockPlan();
    const { app, repo, store } = makeAskApp(engine.impl);
    const learner = repo.createLearner("小明", "elementary_upper");
    const first = await post(app, "/api/v1/ask", { learnerId: learner.id, problem: PROBLEM });
    const job = await waitAskJob(app, first.body.jobId);
    expect(engine.calls.length).toBe(1);

    const again = await post(app, "/api/v1/ask", { learnerId: learner.id, problem: `  ${PROBLEM}  ` });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("ready");
    expect(again.body.isNew).toBe(false);
    expect(again.body.question.id).toBe(job.question.id);
    expect(again.body.question.answer).toBeUndefined();
    expect(engine.calls.length).toBe(1);
    expect(store.all.filter((q) => q.stem === PROBLEM).length).toBe(1);
  });

  it("引擎解不出可判卷答案时诚实失败；主观答案降级为 steps 并进家长判卷", async () => {
    const failing = makeAskApp(mockPlan({ answer: "", steps: [] }).impl);
    const f = await post(failing.app, "/api/v1/ask", { learnerId: undefined, problem: PROBLEM });
    const failedJob = await waitAskJob(failing.app, f.body.jobId);
    expect(failedJob.status).toBe("failed");
    expect(failedJob.error).toContain("可判卷答案");

    const subjective = makeAskApp(
      mockPlan({ answer: "先求出长与宽的和，再把它乘以二", steps: ["设长为a，宽为b", "周长 = 两倍的和"] }).impl,
    );
    const learner = subjective.repo.createLearner("小刚", "middle");
    const asked = await post(subjective.app, "/api/v1/ask", {
      learnerId: learner.id,
      problem: "为什么长方形的周长等于长与宽的和的两倍？请说明理由。",
    });
    const job = await waitAskJob(subjective.app, asked.body.jobId);
    expect(job.status).toBe("done");
    expect(job.question.answerType).toBe("steps");

    const submitted = await post(subjective.app, "/api/v1/practice/submit", {
      learnerId: learner.id,
      questionId: job.question.id,
      answer: "因为对边相等，两条长加两条宽",
      source: "daily",
    });
    expect(submitted.body.needsReview).toBe(true);
    expect(submitted.body.method).toBe("pending");
    expect(subjective.repo.pendingReviewAttempts(learner.id).length).toBe(1);
  });

  it("running 任务按 learner 限定：别人的任务不能当自己的轮询句柄", () => {
    const { repo } = makeAskApp(mockPlan().impl);
    const a = repo.createLearner("小明", "elementary_upper");
    const b = repo.createLearner("小红", "elementary_upper");
    const jobId = repo.createAskJob({ learnerId: a.id, questionId: "free-x", problem: PROBLEM });
    expect(repo.runningAskJobForQuestion("free-x", a.id)).toBe(jobId);
    expect(repo.runningAskJobForQuestion("free-x", b.id)).toBeUndefined();
    expect(repo.runningAskJobForQuestion("free-x", undefined)).toBeUndefined();
    repo.finishAskJob(jobId, "free-x");
    expect(repo.runningAskJobForQuestion("free-x", a.id)).toBeUndefined();
  });

  it("引擎离线时诚实拒绝（不造答案）", async () => {
    const { app, repo } = makeAskApp(mockPlan().impl, { offline: true });
    const learner = repo.createLearner("小明", "elementary_upper");
    const res = await post(app, "/api/v1/ask", { learnerId: learner.id, problem: PROBLEM });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("离线");
  });

  it("参数与归属：题干过短被拒；learner 不存在 404", async () => {
    const { app } = makeAskApp(mockPlan().impl);
    expect((await post(app, "/api/v1/ask", { problem: "1+1" })).status).toBe(400);
    expect(
      (await post(app, "/api/v1/ask", { learnerId: "nobody", problem: PROBLEM })).status,
    ).toBe(404);
  });

  it("孩子只能给自己提问，也只能看自己的提问任务", async () => {
    const engine = mockPlan();
    const env = tempFixtureEnv([makeQuestion({ id: "bank1", answer: "7" })]);
    const db = openMemoryDb();
    env.state.repo = new Repo(db);
    env.state.auth = new AuthStore(db);
    env.state.authDisabled = false;
    env.state.contract = CONTRACT;
    env.state.engineFetch = engine.impl;
    const app = createApp(env.state);

    const call = (cookie: string) => async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any>, res };
    };
    const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

    const setup = await call("")("POST", "/api/v1/auth/setup-parent", { username: "妈妈", password: "family" });
    const parentCookie = cookieOf(setup.res);
    const regA = await call("")("POST", "/api/v1/auth/register-child", {
      username: "小明", password: "1234", level: "elementary_upper",
    });
    const cookieA = cookieOf(regA.res);
    const learnerA = regA.body.user.learnerId as string;
    const regB = await call("")("POST", "/api/v1/auth/register-child", {
      username: "小红", password: "1234", level: "elementary_upper",
    });
    const cookieB = cookieOf(regB.res);
    const learnerB = regB.body.user.learnerId as string;

    // 小明冒充小红提问 → 强制归属小明
    const asked = await call(cookieA)("POST", "/api/v1/ask", { learnerId: learnerB, problem: PROBLEM });
    expect(asked.status).toBe(202);
    for (let i = 0; i < 50; i++) {
      const polled = await call(cookieA)("GET", `/api/v1/ask/jobs/${asked.body.jobId}`);
      if (polled.body.status !== "running") {
        expect(polled.body.status).toBe("done");
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(engine.calls[0]!.body.learner_id).toBe(learnerA);
    // 入库批次文件按提问者归档
    const files = readdirSync(path.join(env.dataDir, "knowledge", "questions"));
    expect(files).toContain(`asked-${learnerA}.json`);
    expect(files).not.toContain(`asked-${learnerB}.json`);

    // 小红看不到小明的提问任务；家长可以（抽检需要）
    expect((await call(cookieB)("GET", `/api/v1/ask/jobs/${asked.body.jobId}`)).status).toBe(403);
    expect((await call(parentCookie)("GET", `/api/v1/ask/jobs/${asked.body.jobId}`)).status).toBe(200);
    // 未登录一律拒绝
    expect((await call("")("POST", "/api/v1/ask", { problem: PROBLEM })).status).toBe(401);
  });
});

describe("classifyAnswer: 判卷方式分级", () => {
  it("单个数值走 numeric，代数式走 expression，其余进家长抽检", () => {
    expect(classifyAnswer("26")).toBe("numeric");
    expect(classifyAnswer("26 厘米")).toBe("numeric");
    expect(classifyAnswer("周长是 26 厘米")).toBe("numeric");
    expect(classifyAnswer("3/4")).toBe("numeric");
    expect(classifyAnswer("50%")).toBe("numeric");
    expect(classifyAnswer("x=4")).toBe("numeric");
    expect(classifyAnswer("2x+3")).toBe("expression");
    expect(classifyAnswer("(a+b)*2")).toBe("expression");
    // 多个数值：parseNumeric 只取第一个会误判 → 交家长
    expect(classifyAnswer("长8厘米，宽5厘米，周长26厘米")).toBe("steps");
    expect(classifyAnswer("因为对边相等，所以两条长加两条宽")).toBe("steps");
    expect(classifyAnswer("")).toBe("steps");
  });
});
