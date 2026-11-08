import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { judgeReading, normalizeReadingAnswer } from "../src/reading.js";
import { isWav, synthesizeSpeech } from "../src/voice.js";
import {
  checkRequirements,
  containsMathAnswer,
  guardFeedbackLine,
  reviewWriting,
  WRITING_FALLBACK,
  type WritingPrompt,
} from "../src/writing.js";
import { latencyPercentiles, speakingPrompt, loadScenarios, SPEAKING_OFF_TOPIC_REPLY } from "../src/speaking.js";
import { fillsBlank, redactRevealing } from "../src/routes/english.js";
import { knowledge, makeQuestion, tempFixtureEnv } from "./helpers.js";

/**
 * 英语服务端这一轮对抗审查的修复（english-server 区域）。
 *
 * 每一组锁一条 finding：听力不念答案、各入口三道闸、语法页不泄题、
 * 写作反馈不替孩子写也不算数学、一致性检查不装作知道、口语原话按开关落库、
 * 延迟有分位、语速可调、坏音频不进缓存、阅读判卷的宽松归一。
 */

/** 44 字节头 + 若干静音帧的最小合法 wav */
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

const PASSAGE = {
  id: "r-fix-test",
  title: "Fix Test",
  level: "A1",
  text: "Tom gets up at seven o'clock. He goes to the park with his dog.",
  questions: [
    { id: "q1", prompt: "What time does Tom get up?", answer: "seven o'clock / 7:00", evidence: "Tom gets up at seven o'clock." },
    { id: "q2", prompt: "Where does he go?", answer: "the park", evidence: "He goes to the park with his dog." },
  ],
};

let readingDir = "";
beforeEach(() => {
  readingDir = mkdtempSync(path.join(tmpdir(), "mathtutor-fix-en-"));
  writeFileSync(path.join(readingDir, "fix.json"), JSON.stringify(PASSAGE), "utf8");
  process.env.ENGLISH_READING_DIR = readingDir;
});
afterEach(() => {
  delete process.env.ENGLISH_READING_DIR;
});

interface EnvOpts {
  tts?: "wav" | "mp3" | "fail";
  replies?: string[];
  questions?: ReturnType<typeof makeQuestion>[];
  authed?: boolean;
}

function makeEnv(opts: EnvOpts = {}) {
  const env = tempFixtureEnv(opts.questions ?? [makeQuestion({ id: "q-fix", answer: "26" })]);
  const db = openMemoryDb();
  const queue = [...(opts.replies ?? [])];
  const ttsBodies: unknown[] = [];
  const state: AppState = {
    ...env.state,
    repo: new Repo(db),
    ...(opts.authed ? { auth: new AuthStore(db), authDisabled: false } : {}),
    hintProvider: { generate: async () => queue.shift() ?? "{}" },
    engineFetch: (async (input: string | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/v1/tts")) {
        ttsBodies.push(JSON.parse(String(init?.body ?? "{}")));
        if (opts.tts === "fail") return new Response("no tts", { status: 501 });
        // API 通路：200 但回的是 mp3 字节，不是 wav
        if (opts.tts === "mp3") return new Response(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0]), { status: 200 });
        return new Response(new Uint8Array(tinyWav()), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  const app = createApp(state);
  const call = async (method: string, url: string, body?: unknown, cookie?: string) => {
    const res = await app.request(url, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any, setCookie: res.headers.get("set-cookie") };
  };
  return { ...env, state, app, call, ttsBodies };
}

const exhaust = (state: AppState, learnerId: string) => state.repo.appendEvent(learnerId, "active-usage", { seconds: 6 * 3600 });

describe("A-01/C-04/E-04 听力作答：答错不念答案，第三次才给参考答案，作答留痕", () => {
  it("答错只回 {correct:false, retry:true}；答对才给原文依据", async () => {
    const env = makeEnv();
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const wrong = await env.call("POST", "/api/v1/en/listening/answer", {
      learnerId: learner.id, passageId: PASSAGE.id, questionId: "q1", answer: "six",
    });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toEqual({ correct: false, retry: true });

    const right = await env.call("POST", "/api/v1/en/listening/answer", {
      learnerId: learner.id, passageId: PASSAGE.id, questionId: "q1", answer: "7:00",
    });
    expect(right.body.correct).toBe(true);
    expect(right.body.evidence).toContain("seven o'clock");
    expect(right.body.reference).toBeUndefined();
  });

  it("同一题当天错两次，第三次还错才给 reference，并在事件里标 revealed", async () => {
    const env = makeEnv();
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const answer = () =>
      env.call("POST", "/api/v1/en/listening/answer", {
        learnerId: learner.id, passageId: PASSAGE.id, questionId: "q2", answer: "school",
      });
    const first = await answer();
    const second = await answer();
    expect(first.body.reference).toBeUndefined();
    expect(second.body.reference).toBeUndefined();
    expect(second.body.evidence).toBeUndefined();
    const third = await answer();
    expect(third.body.correct).toBe(false);
    expect(third.body.reference).toBe("the park");
    // 答错永远不给原文那一句
    expect(third.body.evidence).toBeUndefined();

    const events = env.state.repo.listEvents(learner.id, "listening-answer");
    expect(events).toHaveLength(3);
    expect((events[2]!.payload as { revealed?: boolean }).revealed).toBe(true);
    expect((events[0]!.payload as { revealed?: boolean }).revealed).toBeUndefined();
    // 不留孩子写的原文
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("school");
  });

  it("别的题的错不累计到这一题", async () => {
    const env = makeEnv();
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    for (let i = 0; i < 3; i++) {
      await env.call("POST", "/api/v1/en/listening/answer", { learnerId: learner.id, passageId: PASSAGE.id, questionId: "q1", answer: "x" });
    }
    const other = await env.call("POST", "/api/v1/en/listening/answer", {
      learnerId: learner.id, passageId: PASSAGE.id, questionId: "q2", answer: "x",
    });
    expect(other.body).toEqual({ correct: false, retry: true });
  });

  it("④ 听力里亮过答案的题，阅读里再答对不算读完", async () => {
    const env = makeEnv();
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    for (let i = 0; i < 3; i++) {
      await env.call("POST", "/api/v1/en/listening/answer", { learnerId: learner.id, passageId: PASSAGE.id, questionId: "q2", answer: "x" });
    }
    const q1 = await env.call("POST", "/api/v1/en/reading/answer", { learnerId: learner.id, passageId: PASSAGE.id, questionId: "q1", answer: "seven o'clock" });
    const q2 = await env.call("POST", "/api/v1/en/reading/answer", { learnerId: learner.id, passageId: PASSAGE.id, questionId: "q2", answer: "the park" });
    expect(q1.body.counted).toBe(true);
    expect(q2.body.correct).toBe(true);
    expect(q2.body.counted).toBe(false);

    const list = await env.call("GET", `/api/v1/en/reading/list?learnerId=${learner.id}`);
    const row = list.body.passages.find((p: { id: string }) => p.id === PASSAGE.id);
    expect(row.answered).toBe(1);
    expect(row.done).toBe(false);
  });
});

describe("C-04/D-06/A-08/E-05 听力作答、阅读原文、阅读作答都过 learner + 模块 + 时长三道闸", () => {
  it("缺 learner → 400，learner 不存在 → 404", async () => {
    const env = makeEnv();
    expect((await env.call("GET", `/api/v1/en/reading/passage?id=${PASSAGE.id}`)).status).toBe(400);
    expect((await env.call("GET", `/api/v1/en/reading/passage?id=${PASSAGE.id}&learnerId=nobody`)).status).toBe(404);
    expect(
      (await env.call("POST", "/api/v1/en/listening/answer", { learnerId: "nobody", passageId: PASSAGE.id, questionId: "q1", answer: "x" })).status,
    ).toBe(404);
  });

  it("有 learner 时阅读原文照常下发，且不带答案", async () => {
    const env = makeEnv();
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const res = await env.call("GET", `/api/v1/en/reading/passage?id=${PASSAGE.id}&learnerId=${learner.id}`);
    expect(res.status).toBe(200);
    expect(res.body.text).toContain("Tom gets up");
    expect(JSON.stringify(res.body)).not.toContain("evidence");
  });

  it("英语被关 → 三个入口都 403", async () => {
    const env = makeEnv();
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    env.state.repo.setLearnerPrefs(learner.id, { modules: { english: false } });
    const body = { learnerId: learner.id, passageId: PASSAGE.id, questionId: "q1", answer: "seven" };
    expect((await env.call("GET", `/api/v1/en/reading/passage?id=${PASSAGE.id}&learnerId=${learner.id}`)).status).toBe(403);
    expect((await env.call("POST", "/api/v1/en/reading/answer", body)).status).toBe(403);
    expect((await env.call("POST", "/api/v1/en/listening/answer", body)).status).toBe(403);
  });

  it("时长用完 → 三个入口都 429", async () => {
    const env = makeEnv();
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    exhaust(env.state, learner.id);
    const body = { learnerId: learner.id, passageId: PASSAGE.id, questionId: "q1", answer: "seven" };
    expect((await env.call("GET", `/api/v1/en/reading/passage?id=${PASSAGE.id}&learnerId=${learner.id}`)).status).toBe(429);
    expect((await env.call("POST", "/api/v1/en/reading/answer", body)).status).toBe(429);
    expect((await env.call("POST", "/api/v1/en/listening/answer", body)).status).toBe(429);
    // 被挡下的作答不留痕
    expect(env.state.repo.listEvents(learner.id, "listening-answer")).toHaveLength(0);
  });
});

describe("C-01 语法单元页：会泄题的教材原句不和题干同屏", () => {
  const NODE = "en:grammar-1-am-is-are";
  it("redactRevealing 去掉与题干是同一句的句子，其余保留", () => {
    const q = makeQuestion({ id: "g", nodeIds: [NODE], stem: "My name ___ Lisa.", answer: "is" });
    const out = redactRevealing("I’m 22. My name is Lisa. I’m from Chicago.", [q]);
    expect(out).not.toContain("Lisa");
    expect(out).toContain("Chicago");
    expect(redactRevealing("I’m 22.", [q])).toBe("I’m 22.");
    expect(redactRevealing(undefined, [q])).toBeUndefined();
  });

  it("/grammar/unit/:id 下发的 summary / whatIsIt 不含能照抄的那句", async () => {
    expect(knowledge.index.getNode(NODE)?.summary).toContain("My name is Lisa");
    const env = makeEnv({
      questions: [makeQuestion({ id: "en-g-leak", nodeIds: [NODE], stem: "用 am/is/are 填空：My name ___ Lisa.", answer: "is" })],
    });
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const res = await env.call("GET", `/api/v1/en/grammar/unit/${encodeURIComponent(NODE)}?learnerId=${learner.id}`);
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(1);
    expect(res.body.unit.summary).not.toContain("My name is Lisa");
    expect(res.body.unit.whatIsIt ?? "").not.toContain("My name is Lisa");
    // 不泄题的句子照常留着，单元说明没被整段抹掉
    expect(res.body.unit.summary).toContain("Chicago");
  });
});

const TASK: WritingPrompt = {
  id: "w-test",
  title: "t",
  level: "A1",
  prompt: "Write 3 sentences about your school. Use 'There is / There are'.",
  minWords: 10,
  mustUse: ["There is", "There are"],
  tips: [],
};

describe("C-05/D-05/E-07 写作 tip/praise：过输出安检，不替孩子写", () => {
  const essay = "There is a big playground. My classroom have two window.";

  it("tip 里出现成段英文（≥6 词）且不是孩子原句 → 换成只指位置的提示", () => {
    const out = guardFeedbackLine("改成：My classroom has two big windows in it.", "tip", essay);
    expect(out).toContain("第 2 句");
    expect(out).not.toMatch(/windows/);
  });

  it("引用孩子自己的原句、或只有零星英文词 → 原样保留", () => {
    expect(guardFeedbackLine("第二句把 have 改成 has。", "tip", essay)).toBe("第二句把 have 改成 has。");
    const quote = "“There is a big playground” 写得清楚。";
    expect(guardFeedbackLine(quote, "praise", essay)).toBe(quote);
  });

  it("praise 里替孩子写了整句 → 只说第几句好", () => {
    const out = guardFeedbackLine("You could write: There is a big green playground at my school.", "praise", essay);
    expect(out).toBe("第 1 句写得不错。");
  });

  it("安检拦下 → 固定话术；算式结果 → 固定话术", () => {
    expect(guardFeedbackLine("加我微信", "tip", essay, () => true)).toBe(WRITING_FALLBACK.blocked);
    expect(guardFeedbackLine("37×24=888", "tip", essay)).toBe(WRITING_FALLBACK.math);
  });

  it("走接口时 tip/praise 都过 screenModelOutput（拦下留 safety 事件）", async () => {
    const env = makeEnv({
      replies: [
        '{"structure":3,"vocabulary":3,"grammar":3,"tip":"加我微信 wx12345678 详细讲","praise":"Rewrite it as: There are many tall trees near our school gate."}',
        '{"structure":3,"vocabulary":3,"grammar":3}',
      ],
    });
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const prompts = await env.call("GET", `/api/v1/en/writing/prompts?learnerId=${learner.id}`);
    const res = await env.call("POST", "/api/v1/en/writing/submit", {
      learnerId: learner.id,
      promptId: prompts.body.prompts[0].id,
      text: "There is a big playground. There are two libraries near my classroom.",
    });
    expect(res.status).toBe(200);
    expect(res.body.praise).not.toContain("tall trees");
    // 安检是否拦"微信号"取决于安全规则；拦下时必须是固定话术、且留痕
    if (res.body.tip === WRITING_FALLBACK.blocked) {
      expect(env.state.repo.listEvents(learner.id, "safety").length).toBeGreaterThan(0);
    } else {
      expect(res.body.tip).not.toContain("There are many");
    }
  });
});

describe("C-06 一致性检查：缺分就是缺分、第二次失败就是未知；硬要求确定性检查", () => {
  it("缺分 → 该维度为 null，不补 3", async () => {
    const llm = { generate: async () => '{"structure":4,"tip":"第一句加个句号。","praise":"开头清楚。"}' };
    const fb = await reviewWriting(llm, TASK, "There is a park.");
    expect(fb!.bands).toEqual({ structure: 4, vocabulary: null, grammar: null });
  });

  it("第二次解析失败 → inconsistent=null（未知），不是 false", async () => {
    const queue = ['{"structure":4,"vocabulary":4,"grammar":4,"tip":"t","praise":"p"}', "抱歉我无法评分"];
    const fb = await reviewWriting({ generate: async () => queue.shift() ?? "" }, TASK, "There is a park.");
    expect(fb!.inconsistent).toBeNull();

    const thrown = ['{"structure":4,"vocabulary":4,"grammar":4,"tip":"t","praise":"p"}'];
    const fb2 = await reviewWriting(
      { generate: async () => { const r = thrown.shift(); if (!r) throw new Error("timeout"); return r; } },
      TASK,
      "There is a park.",
    );
    expect(fb2!.inconsistent).toBeNull();
  });

  it("两次都给分且差两档 → true；没差 → false", async () => {
    const q1 = ['{"structure":5,"vocabulary":5,"grammar":5,"tip":"t","praise":"p"}', '{"structure":3,"vocabulary":5,"grammar":5}'];
    expect((await reviewWriting({ generate: async () => q1.shift()! }, TASK, "x"))!.inconsistent).toBe(true);
    const q2 = ['{"structure":4,"vocabulary":4,"grammar":4,"tip":"t","praise":"p"}', '{"structure":4,"vocabulary":4,"grammar":4}'];
    expect((await reviewWriting({ generate: async () => q2.shift()! }, TASK, "x"))!.inconsistent).toBe(false);
  });

  it("mustUse / minWords 服务端自己数", () => {
    expect(checkRequirements(TASK, "There is a park. It is big.")).toEqual({
      mustUseHit: ["There is"],
      mustUseMissing: ["There are"],
      belowMinWords: true,
    });
    const full = checkRequirements(TASK, "There is a park near my home. There are many trees and flowers in it.");
    expect(full.mustUseMissing).toEqual([]);
    expect(full.belowMinWords).toBe(false);
    // 整词匹配：Thereisn't 之类的粘连不算
    expect(checkRequirements({ ...TASK, mustUse: ["is"] }, "This park.").mustUseMissing).toEqual(["is"]);
  });

  it("接口回 requirements，事件里只记统计", async () => {
    const env = makeEnv({ replies: ['{"structure":3,"vocabulary":3,"grammar":3,"tip":"t","praise":"p"}', "bad"] });
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const prompts = await env.call("GET", `/api/v1/en/writing/prompts?learnerId=${learner.id}`);
    const res = await env.call("POST", "/api/v1/en/writing/submit", {
      learnerId: learner.id,
      promptId: prompts.body.prompts[0].id,
      text: "There is a park.",
    });
    expect(res.body.inconsistent).toBeNull();
    expect(res.body.requirements.belowMinWords).toBe(true);
    expect(Array.isArray(res.body.requirements.mustUseMissing)).toBe(true);
    const ev = env.state.repo.listEvents(learner.id, "writing")[0]!.payload as Record<string, unknown>;
    expect(ev.belowMinWords).toBe(true);
    expect(JSON.stringify(ev)).not.toContain("park");
  });
});

describe("A-09 写作与口语不当通用解题通道", () => {
  it("containsMathAnswer 认得出算式结果，不误伤普通数字", () => {
    expect(containsMathAnswer("37×24=888")).toBe(true);
    expect(containsMathAnswer("Sure! 37 x 24 = 888.")).toBe(true);
    expect(containsMathAnswer("37 times 24 is 888")).toBe(true);
    expect(containsMathAnswer("888")).toBe(true);
    expect(containsMathAnswer("I have 2 cats and 3 dogs.")).toBe(false);
    expect(containsMathAnswer("I'm 9 years old. How old are you?")).toBe(false);
    // 审查补的几种直接报答案的说法
    expect(containsMathAnswer("The answer is 888")).toBe(true);
    expect(containsMathAnswer("It's 888!")).toBe(true);
    expect(containsMathAnswer("37*24 is 888")).toBe(true);
    expect(containsMathAnswer("37×24的结果是888")).toBe(true);
    expect(containsMathAnswer("Ten times two is twenty")).toBe(true);
    // 普通对话里的数字照常
    expect(containsMathAnswer("It's 3 o'clock. Let's go!")).toBe(false);
    expect(containsMathAnswer("My brother is 12 and my sister is 7.")).toBe(false);
  });

  it("口语系统提示里写明只用英语对话、不做数学题", () => {
    const prompt = speakingPrompt(loadScenarios()[0]!, []);
    expect(prompt).toContain("不做数学题");
    expect(prompt).toContain("不回答作业");
  });

  it("口语回复里出现算式结果 → 换成固定话术", async () => {
    const env = makeEnv({ replies: ["37 × 24 = 888. Anything else?"] });
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const opened = await env.call("POST", "/api/v1/speaking/session", { learnerId: learner.id });
    const res = await env.call("POST", "/api/v1/speaking/turn", { learnerId: learner.id, sessionId: opened.body.sessionId, text: "What is 37 times 24?" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe(SPEAKING_OFF_TOPIC_REPLY);
    expect(res.body.reply).not.toContain("888");
  });

  it("写作反馈里出现算式结果 → 换成固定话术", async () => {
    const llm = { generate: async () => '{"structure":3,"vocabulary":3,"grammar":3,"tip":"37×24=888","praise":"= 888"}' };
    const fb = await reviewWriting(llm, TASK, "37×24 how much");
    expect(fb!.tip).toBe(WRITING_FALLBACK.math);
    expect(fb!.praise).toBe(WRITING_FALLBACK.math);
  });
});

describe("D-02 口语原话按「记录对话」开关落库", () => {
  async function talk(env: ReturnType<typeof makeEnv>, learnerId: string) {
    const opened = await env.call("POST", "/api/v1/speaking/session", { learnerId });
    const scenario = loadScenarios().find((s) => s.id === opened.body.scenario.id)!;
    // 用上情景里的第一个表达，好看 summary 是不是还按本轮文本算出来
    const said = scenario.expressions[0]!.replace(/[.…]/g, "").trim();
    await env.call("POST", "/api/v1/speaking/turn", { learnerId, sessionId: opened.body.sessionId, text: said });
    const end = await env.call("POST", "/api/v1/speaking/end", { learnerId, sessionId: opened.body.sessionId });
    return { sessionId: opened.body.sessionId as string, said, end };
  }

  it("默认关：speaking_turns 只留 role / 延迟，不留原话；summary 照常算出", async () => {
    const env = makeEnv({ replies: ["Great! Tell me more."] });
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const { sessionId, end } = await talk(env, learner.id);
    const turns = env.state.repo.listSpeakingTurns(sessionId);
    expect(turns.map((t) => t.role)).toEqual(["tutor", "child", "tutor"]);
    for (const t of turns) expect(t.text).toBe("");
    expect(end.body.summary.turns).toBe(1);
    expect(end.body.summary.used.length).toBeGreaterThan(0);
    expect(end.body.summary.childWords).toBeGreaterThan(0);
  });

  it("模型仍拿得到本轮上下文（内存里），不因不落库而失忆", async () => {
    const prompts: string[] = [];
    const env = makeEnv();
    env.state.hintProvider = { generate: async (p: string) => { prompts.push(p); return "Nice. And then?"; } };
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const opened = await env.call("POST", "/api/v1/speaking/session", { learnerId: learner.id });
    await env.call("POST", "/api/v1/speaking/turn", { learnerId: learner.id, sessionId: opened.body.sessionId, text: "I like pandas." });
    await env.call("POST", "/api/v1/speaking/turn", { learnerId: learner.id, sessionId: opened.body.sessionId, text: "They are cute." });
    expect(prompts[1]).toContain("I like pandas.");
    expect(prompts[1]).toContain("Nice. And then?");
  });

  it("打开记录：原话照常落库", async () => {
    const env = makeEnv({ replies: ["Great! Tell me more."] });
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    env.state.repo.setLearnerPrefs(learner.id, { recordTranscript: true });
    const { sessionId, said } = await talk(env, learner.id);
    const texts = env.state.repo.listSpeakingTurns(sessionId).map((t) => t.text);
    expect(texts).toContain(said);
    expect(texts).toContain("Great! Tell me more.");
  });
});

describe("E-03/C-10 口语延迟落库 + P50/P90；可调语速", () => {
  it("latencyPercentiles 最近邻秩", () => {
    expect(latencyPercentiles([])).toEqual({ n: 0, p50: null, p90: null });
    expect(latencyPercentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual({ n: 10, p50: 50, p90: 90 });
    expect(latencyPercentiles([5])).toEqual({ n: 1, p50: 5, p90: 5 });
  });

  it("tutor 行写 latencyMs；/speaking/latency 汇总", async () => {
    const env = makeEnv({ replies: ["Hi!", "Cool!"] });
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const opened = await env.call("POST", "/api/v1/speaking/session", { learnerId: learner.id });
    await env.call("POST", "/api/v1/speaking/turn", { learnerId: learner.id, sessionId: opened.body.sessionId, text: "Hello" });
    await env.call("POST", "/api/v1/speaking/turn", { learnerId: learner.id, sessionId: opened.body.sessionId, text: "Bye" });
    const tutorTurns = env.state.repo.listSpeakingTurns(opened.body.sessionId).filter((t) => t.role === "tutor");
    // 开场白那一行不是一轮应答，没有延迟；两轮应答都有
    expect(tutorTurns.filter((t) => t.latencyMs !== null)).toHaveLength(2);

    const stats = await env.call("GET", `/api/v1/speaking/latency?learnerId=${learner.id}`);
    expect(stats.status).toBe(200);
    expect(stats.body.n).toBe(2);
    expect(typeof stats.body.p50).toBe("number");
    expect(typeof stats.body.p90).toBe("number");
  });

  it("孩子只能看自己的延迟", async () => {
    const env = makeEnv({ authed: true, replies: ["Hi!"] });
    const parent = await env.call("POST", "/api/v1/auth/setup-parent", { username: "爸爸", password: "family-secret" });
    const parentCookie = parent.setCookie!.split(";")[0]!;
    const a = await env.call("POST", "/api/v1/auth/register-child", { username: "小明", password: "child-secret", level: "elementary_upper" });
    const aCookie = a.setCookie!.split(";")[0]!;
    const b = await env.call("POST", "/api/v1/auth/register-child", { username: "小红", password: "child-secret", level: "elementary_upper" });
    const bCookie = b.setCookie!.split(";")[0]!;
    const [la, lb] = env.state.repo.listLearners();
    const aId = env.state.repo.listLearners().find((l) => l.name === "小明")?.id ?? la!.id;
    const bId = env.state.repo.listLearners().find((l) => l.name === "小红")?.id ?? lb!.id;

    const opened = await env.call("POST", "/api/v1/speaking/session", {}, aCookie);
    await env.call("POST", "/api/v1/speaking/turn", { sessionId: opened.body.sessionId, text: "Hello" }, aCookie);

    // 小红请求小明的统计：被强制成自己的（0 轮）
    const peek = await env.call("GET", `/api/v1/speaking/latency?learnerId=${aId}`, undefined, bCookie);
    expect(peek.status).toBe(200);
    expect(peek.body.learnerId).toBe(bId);
    expect(peek.body.n).toBe(0);
    // 家长看得到
    const viaParent = await env.call("GET", `/api/v1/speaking/latency?learnerId=${aId}`, undefined, parentCookie);
    expect(viaParent.body.n).toBe(1);
  });

  it("speed 传给 TTS；超出 0.7–1.2 → 400", async () => {
    const env = makeEnv({ replies: ["Hi!"] });
    const learner = env.state.repo.createLearner("小测", "elementary_upper");
    const opened = await env.call("POST", "/api/v1/speaking/session", { learnerId: learner.id, speed: 0.8 });
    expect(opened.status).toBe(200);
    await env.call("POST", "/api/v1/speaking/turn", { learnerId: learner.id, sessionId: opened.body.sessionId, text: "Hello", speed: 1.1 });
    expect(env.ttsBodies.map((b) => (b as { speed?: number }).speed)).toEqual([0.8, 1.1]);

    expect((await env.call("POST", "/api/v1/speaking/session", { learnerId: learner.id, speed: 2 })).status).toBe(400);
    expect(
      (await env.call("POST", "/api/v1/speaking/turn", { learnerId: learner.id, sessionId: opened.body.sessionId, text: "Hi", speed: 0.5 })).status,
    ).toBe(400);
  });
});

describe("C-07 TTS 回的不是 wav：当没合成，听力不缓存坏音频", () => {
  it("isWav 只认 RIFF....WAVE", () => {
    expect(isWav(tinyWav())).toBe(true);
    expect(isWav(Buffer.from("RIFF"))).toBe(false);
    // 光头壳子：RIFF/WAVE/fmt 都对，但没有 data 块（或 data 是空的）
    expect(isWav(tinyWav().subarray(0, 36))).toBe(false);
    expect(isWav(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
  });

  it("synthesizeSpeech 遇到 mp3 字节返回 null", async () => {
    const env = makeEnv({ tts: "mp3" });
    expect(await synthesizeSpeech(env.state, "hello")).toBeNull();
  });

  it("听力：API 通路回 mp3 → 不写缓存、如实说不可用；旧的坏缓存被丢弃重合成", async () => {
    const bad = makeEnv({ tts: "mp3" });
    const learner = bad.state.repo.createLearner("小测", "elementary_upper");
    const res = await bad.call("GET", `/api/v1/en/listening/passage/${PASSAGE.id}?learnerId=${learner.id}`);
    expect(res.body.audio).toBeNull();
    expect(res.body.ttsAvailable).toBe(false);
    const file = path.join(bad.state.config.dataDir, "listening", `${PASSAGE.id}.wav`);
    expect(existsSync(file)).toBe(false);

    // 模拟早先没校验时写下的坏缓存
    const good = makeEnv({ tts: "wav" });
    const l2 = good.state.repo.createLearner("小测", "elementary_upper");
    const file2 = path.join(good.state.config.dataDir, "listening", `${PASSAGE.id}.wav`);
    mkdirSync(path.dirname(file2), { recursive: true });
    writeFileSync(file2, Buffer.from([0x49, 0x44, 0x33]));
    const res2 = await good.call("GET", `/api/v1/en/listening/passage/${PASSAGE.id}?learnerId=${l2.id}`);
    expect(res2.body.ttsAvailable).toBe(true);
    expect(isWav(readFileSync(file2))).toBe(true);
  });
});

describe("G-02 阅读/听力判卷的宽松归一（仍不调模型）", () => {
  const q = { id: "q", prompt: "p", answer: "the park / six eggs", evidence: "e" };
  it("开头冠词、结尾标点、数字词与阿拉伯数字互认", () => {
    expect(judgeReading(q, "park").correct).toBe(true);
    expect(judgeReading(q, "A park.").correct).toBe(true);
    expect(judgeReading(q, "6 eggs!").correct).toBe(true);
    expect(judgeReading({ ...q, answer: "12" }, "twelve").correct).toBe(true);
    expect(judgeReading({ ...q, answer: "twenty" }, "20").correct).toBe(true);
    expect(judgeReading(q, "school").correct).toBe(false);
    expect(judgeReading(q, "").correct).toBe(false);
  });

  it("按词边界换数字词：someone 里的 one 不动", () => {
    expect(normalizeReadingAnswer("Someone")).toBe("someone");
    expect(normalizeReadingAnswer("The one")).toBe("1");
  });
});

describe("C-01 补漏：短题干的泄题看「空两边的词 + 答案」", () => {
  const q = (stem: string, answer: string) => makeQuestion({ id: "x", stem, answer });
  it("真题库里审查发现的三处漏：It's raining / They're running / I'm 22", () => {
    expect(fillsBlank("It's raining.", q("用现在进行时填空：It ___ (rain) now.", "is raining"))).toBe(true);
    expect(fillsBlank("They're running.", q("用现在进行时填空：They ___ (run) in the park.", "are running"))).toBe(true);
    expect(fillsBlank("I'm 22.", q("用 be 动词的适当形式填空：I ___ 22 years old.", "am"))).toBe(true);
    expect(
      redactRevealing("We use am with I. I'm 22.", [q("用 be 动词的适当形式填空：I ___ 22 years old.", "am")]),
    ).toBe("We use am with I.");
  });
  it("不误伤只是用到同一个词的讲解句", () => {
    expect(fillsBlank("This is my book.", q("用 be 动词的适当形式填空：My name ___ Lisa.", "is"))).toBe(false);
    expect(fillsBlank("We use am with I.", q("用 be 动词的适当形式填空：I ___ 22 years old.", "am"))).toBe(false);
  });
  it("多种写法的答案（/ 分隔）和缩写都认", () => {
    expect(fillsBlank("He doesn't play golf.", q("改成否定句：He ___ (not play) tennis.", "doesn't play / does not play"))).toBe(
      true,
    );
    expect(fillsBlank("Are you from China?", q("改成问句，填第一个词：___ you married?", "Are"))).toBe(true);
  });
});
