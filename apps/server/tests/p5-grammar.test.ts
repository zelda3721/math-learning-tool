import { describe, expect, it } from "vitest";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { knowledge, makeQuestion, tempFixtureEnv } from "./helpers.js";
import { buildLessonFromDraft, lessonPrompt } from "../src/classroom/generate.js";

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

  it("语法课的 generate：例句必须逐字来自教材", () => {
    const node = knowledge.index.getNode(GRAMMAR_NODE!)!;
    // 教材 summary 里的原句
    const material = (node.summary ?? "").split(/(?<=[.?!])\s+/)[0]!;
    const good = {
      visualThesis: "看见 am/is 跟着谁变",
      beats: [
        { role: "intro", narration: "先看这几句里 be 动词长什么样。" },
        { role: "example", narration: material, visual: { id: "s1", primitive: "en.sentence_highlight", params: { text: material } } },
        { role: "summary", narration: "读一遍，注意框住的那一段。" },
      ],
    };
    expect(buildLessonFromDraft(node, good, null).ok).toBe(true);

    const invented = {
      ...good,
      beats: [
        { role: "intro", narration: "先看这几句。" },
        {
          role: "example",
          narration: "My name is Tommy.",
          visual: { id: "s1", primitive: "en.sentence_highlight", params: { text: "My name is Tommy." } },
        },
        { role: "summary", narration: "读完。" },
      ],
    };
    const bad = buildLessonFromDraft(node, invented, null);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("教材原文");
  });

  it("语法课的 generate：旁白先把要填的那句讲出来 → 退回 compose", () => {
    const node = knowledge.index.getNode(GRAMMAR_NODE!)!;
    const question = makeQuestion({ id: "q-reveal", nodeIds: [GRAMMAR_NODE!], stem: "My name ___ Lisa.", answer: "is" });
    const leaking = {
      visualThesis: "看见 be 动词跟着主语变",
      beats: [
        { role: "intro", narration: "My name is Lisa, 这个句子里的 be 动词是 is。" },
        { role: "concept", narration: "be 动词要跟着主语变。" },
        { role: "summary", narration: "记住了吗。" },
      ],
    };
    const res = buildLessonFromDraft(node, leaking, question);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("先讲出来");
  });

  it("语法课的提示词要求逐字照抄例句、且不写答案", () => {
    const node = knowledge.index.getNode(GRAMMAR_NODE!)!;
    const prompt = lessonPrompt(node);
    expect(prompt).toContain("英语语法点");
    expect(prompt).toContain("不许自己造英文句子");
    expect(prompt).toContain("en.sentence_highlight");
    expect(prompt).not.toContain("number_line");
  });
});
