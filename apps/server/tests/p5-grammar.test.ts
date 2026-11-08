import { describe, expect, it } from "vitest";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { knowledge, makeQuestion, tempFixtureEnv } from "./helpers.js";

/**
 * 英语语法（阶段 5）：单元目录 + 单元详情 + 走既有判卷通路。
 *
 * 语法不应该藏在「课堂」里——它是英语的主干之一，孩子要能在英语页直接找到
 * "这一单元讲什么、有没有题可练"。这里锁住三件事：
 * ① 单元来自教材（115 个，带题数），不是模型编的；
 * ② 下发的题**没有答案**；
 * ③ 语法题走 /practice/submit，和数学同一条证据纪律（verification=reference）。
 */

const GRAMMAR_NODE = knowledge.index.getNode("en:grammar-1-am-is-are") ? "en:grammar-1-am-is-are" : undefined;

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

function makeEnv(questions = [makeQuestion({ id: "en-g1", nodeIds: [GRAMMAR_NODE!], stem: "I ___ a student.", answer: "am" })]) {
  const env = tempFixtureEnv(questions);
  const db = openMemoryDb();
  const state: AppState = { ...env.state, repo: new Repo(db), auth: new AuthStore(db), authDisabled: false };
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

describe("语法单元目录", () => {
  it("单元来自教材：115 个，带题数与一句话说明", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const res = await child.call("GET", `/api/v1/en/grammar/units?learnerId=${learnerId}`);
    expect(res.status).toBe(200);
    const units = res.body.units as { id: string; name: string; questionCount: number; summary: string }[];
    expect(units.length).toBeGreaterThanOrEqual(100);
    expect(units[0]!.id).toMatch(/^en:grammar-/);
    expect(units[0]!.name.length).toBeGreaterThan(0);
    // fixture 那道题挂在 Unit 1 上
    expect(units.find((u) => u.id === GRAMMAR_NODE)!.questionCount).toBe(1);
  });

  it("单元详情：题面下发，答案不下发", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const res = await child.call("GET", `/api/v1/en/grammar/unit/${encodeURIComponent(GRAMMAR_NODE!)}?learnerId=${learnerId}`);
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(1);
    const q = res.body.questions[0];
    expect(q.stem).toContain("___");
    expect(q).not.toHaveProperty("answer");
    expect(res.body.lessonAvailable).toBe(true);
  });

  it("不是语法节点 → 404；英语模块被关 → 403", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const notGrammar = await child.call("GET", `/api/v1/en/grammar/unit/counting-20?learnerId=${learnerId}`);
    expect(notGrammar.status).toBe(404);

    env.state.repo.setLearnerPrefs(learnerId, { modules: { english: false } });
    const blocked = await child.call("GET", `/api/v1/en/grammar/units?learnerId=${learnerId}`);
    expect(blocked.status).toBe(403);
  });

  it("语法题走既有判卷：对的算 reference 证据，错的照常记", async () => {
    const env = makeEnv();
    const { child } = await withChild(env);
    const ok = await child.call("POST", "/api/v1/practice/submit", { questionId: "en-g1", answer: "am" });
    expect(ok.status).toBe(200);
    expect(ok.body.correct).toBe(true);
    expect(ok.body.verification).toBe("reference");
    expect(ok.body.mastery[0].nodeId).toBe(GRAMMAR_NODE);

    const bad = await child.call("POST", "/api/v1/practice/submit", { questionId: "en-g1", answer: "is" });
    expect(bad.body.correct).toBe(false);
  });

  it("前端不传 learnerId 也能用（孩子会话自己带）", async () => {
    const env = makeEnv();
    const { child } = await withChild(env);
    const res = await child.call("POST", "/api/v1/practice/submit", { questionId: "en-g1", answer: "am" });
    expect(res.status).toBe(200);
  });
});
