import { describe, expect, it } from "vitest";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { concatWav, splitForSpeech } from "../src/voice.js";
import { countWords, loadWriting } from "../src/writing.js";
import { makeQuestion, tempFixtureEnv } from "./helpers.js";

/**
 * 听力与写作（阶段 5）。
 *
 * 两条线各有一条不能破的规矩：
 * ① 听力**不把原文发下去**——发了就成了"看着原文做听力题"；
 * ② 写作 feedback 一律 `ai_unverified`，不进掌握度，而且两次评分离得太远时要明说"这次反馈不稳"。
 */

/** 44 字节头 + 若干静音帧的最小合法 wav（mono/16bit/22050） */
function tinyWav(frames = 8): Buffer {
  const data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(22050 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

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

function makeEnv(opts: { tts?: boolean; replies?: string[] } = {}) {
  const env = tempFixtureEnv([makeQuestion({ id: "q1", answer: "26" })]);
  const db = openMemoryDb();
  const queue = [...(opts.replies ?? [])];
  const state: AppState = {
    ...env.state,
    repo: new Repo(db),
    auth: new AuthStore(db),
    authDisabled: false,
    hintProvider: { generate: async () => queue.shift() ?? "{}" },
    engineFetch: (async (input: string | URL) => {
      if (String(input).endsWith("/api/v1/tts")) {
        if (opts.tts === false) return new Response("no tts", { status: 501 });
        return new Response(new Uint8Array(tinyWav()), { status: 200 });
      }
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

describe("听力", () => {
  it("列表只给标题与题数，不给原文", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const res = await child.call("GET", `/api/v1/en/listening/list?learnerId=${learnerId}`);
    expect(res.status).toBe(200);
    const first = res.body.passages[0];
    expect(first.title).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain("supermarket goes to");
  });

  it("打开一篇：有音频、有题面，但**没有原文也没有答案**", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const list = await child.call("GET", `/api/v1/en/listening/list?learnerId=${learnerId}`);
    const id = list.body.passages[0].id;
    const res = await child.call("GET", `/api/v1/en/listening/passage/${id}?learnerId=${learnerId}`);
    expect(res.status).toBe(200);
    expect(res.body.audio).toBeTruthy();
    expect(res.body.ttsAvailable).toBe(true);
    expect(res.body.questions.length).toBeGreaterThan(0);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('"text"');
    expect(raw).not.toContain("On Saturday morning");
    expect(raw).not.toContain("evidence");
  });

  it("没有语音后端：诚实说做不了，也不偷偷把原文给出去", async () => {
    const env = makeEnv({ tts: false });
    const { child, learnerId } = await withChild(env);
    const list = await child.call("GET", `/api/v1/en/listening/list?learnerId=${learnerId}`);
    const id = list.body.passages[0].id;
    const res = await child.call("GET", `/api/v1/en/listening/passage/${id}?learnerId=${learnerId}`);
    expect(res.status).toBe(200);
    expect(res.body.audio).toBeNull();
    expect(res.body.ttsAvailable).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("On Saturday morning");
  });

  it("答题：答完才给原文依据", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const list = await child.call("GET", `/api/v1/en/listening/list?learnerId=${learnerId}`);
    const id = list.body.passages[0].id;
    const detail = await child.call("GET", `/api/v1/en/listening/passage/${id}?learnerId=${learnerId}`);
    const q = detail.body.questions[0];
    const wrong = await child.call("POST", "/api/v1/en/listening/answer", {
      learnerId,
      passageId: id,
      questionId: q.id,
      answer: "definitely wrong",
    });
    expect(wrong.status).toBe(200);
    expect(wrong.body.correct).toBe(false);
    expect(wrong.body.evidence.length).toBeGreaterThan(0);
    expect(wrong.body.reference).toBeTruthy();
  });
});

describe("写作", () => {
  it("任务列表来自内容文件", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const res = await child.call("GET", `/api/v1/en/writing/prompts?learnerId=${learnerId}`);
    expect(res.status).toBe(200);
    expect(res.body.prompts.length).toBe(loadWriting().length);
    expect(res.body.prompts[0].mustUse.length).toBeGreaterThan(0);
  });

  it("批改：给量规分 + 建议，并标清 ai_unverified、不进掌握度", async () => {
    const env = makeEnv({
      replies: [
        '{"structure":4,"vocabulary":3,"grammar":3,"tip":"第二句把 is 改成 are。","praise":"开头写得清楚。"}',
        '{"structure":4,"vocabulary":3,"grammar":3}',
      ],
    });
    const { child, learnerId } = await withChild(env);
    const res = await child.call("POST", "/api/v1/en/writing/submit", {
      learnerId,
      promptId: loadWriting()[0]!.id,
      text: "There is a big playground. There are two libraries near my classroom.",
    });
    expect(res.status).toBe(200);
    expect(res.body.bands.grammar).toBe(3);
    expect(res.body.tip).toContain("are");
    expect(res.body.verification).toBe("ai_unverified");
    expect(res.body.countedTowardMastery).toBe(false);
    expect(res.body.inconsistent).toBe(false);

    const events = env.state.repo.listEvents(learnerId, "writing");
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { verification: string }).verification).toBe("ai_unverified");
    // 不落全文
    expect(JSON.stringify(events[0]!.payload)).not.toContain("playground");
  });

  it("两次评分差出两档：明说这次反馈不稳", async () => {
    const env = makeEnv({
      replies: ['{"structure":5,"vocabulary":5,"grammar":5,"tip":"很好","praise":"很好"}', '{"structure":2,"vocabulary":2,"grammar":2}'],
    });
    const { child, learnerId } = await withChild(env);
    const res = await child.call("POST", "/api/v1/en/writing/submit", {
      learnerId,
      promptId: loadWriting()[0]!.id,
      text: "There is a park.",
    });
    expect(res.status).toBe(200);
    expect(res.body.inconsistent).toBe(true);
  });

  it("没有模型：诚实 503，不编一个分数", async () => {
    const env = makeEnv();
    env.state.hintProvider = null;
    const { child, learnerId } = await withChild(env);
    const res = await child.call("POST", "/api/v1/en/writing/submit", {
      learnerId,
      promptId: loadWriting()[0]!.id,
      text: "There is a park.",
    });
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain("写作反馈");
  });

  it("作文里不该给孩子看的内容会被拦下", async () => {
    const env = makeEnv();
    const { child, learnerId } = await withChild(env);
    const res = await child.call("POST", "/api/v1/en/writing/submit", {
      learnerId,
      promptId: loadWriting()[0]!.id,
      text: "I want to hurt myself.",
    });
    expect(res.status).toBe(422);
  });
});

describe("语音工具", () => {
  it("长文本按句切分，不超过上限", () => {
    const text = "This is one sentence. ".repeat(40).trim();
    const parts = splitForSpeech(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
  });

  it("多段 wav 接起来只有一个小节头", () => {
    const merged = concatWav([tinyWav(4), tinyWav(4), tinyWav(4)]);
    expect(merged.toString("ascii", 0, 4)).toBe("RIFF");
    const dataSize = merged.readUInt32LE(40);
    expect(dataSize).toBe(24); // 12 帧 × 2 字节
    expect(countWords(" hello  world ")).toBe(2);
  });
});
