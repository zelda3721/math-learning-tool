import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Question } from "@mathtutor/schema";
import type { AppState } from "../src/app.js";
import { assessmentRoutes } from "../src/routes/assessment.js";
import {
  assessmentSeenAt,
  buildAssessment,
  buildEnglishAssessment,
  ENGLISH_READING_PASSAGES,
  ENGLISH_VOCAB_COUNT,
} from "../src/assessment.js";
import { loadVocabulary } from "../src/vocabulary.js";
import { loadReading } from "../src/reading.js";
import type { SubjectRegistry } from "../src/subjects.js";
import { makeApp, makeQuestion, NODE_A, NODE_B } from "./helpers.js";

/**
 * 对抗审查修复：阶段测评（E-01 / B-06 / B-04 / D-03 / B-07 / D-04 / E-02）。
 *
 * 守的是"测评数字可信"这一件事：
 * - 前后测可比（同 scope、同题量）、后测不重发前测原题（前测交卷已给答案）；
 * - 同一题不出现两次；判不准的不算对也不算错；题目视图带图、带英文题面；
 * - 只有孩子本人能做、按排期来、只记第一次作答、至少答一半才交卷；
 * - 英语（词汇 + 阅读）也有前后测，家长端按学科分开比。
 */

const DAY = 86_400_000;

function makeEnv(questions: Question[], overrides: Partial<AppState> = {}) {
  const env = makeApp(questions, overrides);
  const learner = env.repo.createLearner("小明", "elementary_upper");
  return { ...env, learnerId: learner.id };
}

async function call(app: Hono, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** 把测评路由挂在一个可以伪造登录角色的壳上（authDisabled 下也能测家长闸） */
function mount(state: AppState, role?: "parent" | "child", learnerId?: string): Hono {
  const outer = new Hono();
  if (role) {
    outer.use("*", async (c, next) => {
      c.set("user", { id: `u-${role}`, role, username: role, ...(learnerId ? { learnerId } : {}) });
      await next();
    });
  }
  outer.route("/a", assessmentRoutes(state));
  return outer;
}

/** 把一份测评答到可以交卷（全部作答） */
async function answerAll(app: Hono, learnerId: string, start: { id: string; questions: { id: string }[] }, answer = "x") {
  for (const q of start.questions) {
    await call(app, "POST", `/a/${start.id}/answer`, { learnerId, questionId: q.id, answer });
  }
  return call(app, "POST", `/a/${start.id}/finish`, { learnerId });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("E-01 / B-06：后测沿用前测 scope、不重发见过的题", () => {
  it("后测与前测同一批节点、同样题量，且一道前测题都不出现", async () => {
    const questions = [
      ...Array.from({ length: 6 }, (_, i) => makeQuestion({ id: `a${i}`, nodeIds: [NODE_A], stem: `A 题 ${i}` })),
      ...Array.from({ length: 6 }, (_, i) => makeQuestion({ id: `b${i}`, nodeIds: [NODE_B], stem: `B 题 ${i}` })),
    ];
    const env = makeEnv(questions);
    const app = mount(env.state);
    const pre = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    expect(pre.status).toBe(200);
    const preIds: string[] = pre.body.questions.map((q: { id: string }) => q.id);
    expect((await answerAll(app, env.learnerId, pre.body)).status).toBe(200);
    const preScope = env.repo.getAssessment(pre.body.id)!.scope;

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8 * DAY));
    const post = await call(app, "POST", "/a/start", { kind: "post", learnerId: env.learnerId });
    expect(post.status).toBe(200);
    const postIds: string[] = post.body.questions.map((q: { id: string }) => q.id);
    expect(env.repo.getAssessment(post.body.id)!.scope).toEqual(preScope);
    expect(postIds).toHaveLength(preIds.length);
    expect(postIds.filter((id) => preIds.includes(id))).toEqual([]);
    expect(post.body.reused).toBe(false);
  });

  it("练习做过的题也不选；题不够时如实标 reused 并在 note 里说明", async () => {
    const questions = Array.from({ length: 5 }, (_, i) => makeQuestion({ id: `a${i}`, nodeIds: [NODE_A] }));
    const env = makeEnv(questions);
    // 练习里做过 a0、a1
    for (const id of ["a0", "a1"]) {
      env.repo.insertAttempt({
        learnerId: env.learnerId,
        questionId: id,
        answer: "26",
        correct: true,
        hintLevelUsed: 0,
        source: "daily",
        needsReview: false,
      });
    }
    const pre = buildAssessment(env.store, env.repo, env.learnerId, { kind: "pre", count: 4 });
    expect(pre.questions.map((q) => q.id).slice(0, 3)).toEqual(["a2", "a3", "a4"]);
    expect(pre.reused).toBe(true);

    const app = mount(env.state);
    const start = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    expect(start.body.reused).toBe(true);
    expect(start.body.note).toContain("如实标出来");
  });

  it("后测题不够新题时，先用练习做过的，最后才用前测里出现过（看过答案）的", async () => {
    const questions = Array.from({ length: 6 }, (_, i) => makeQuestion({ id: `a${i}`, nodeIds: [NODE_A] }));
    const env = makeEnv(questions);
    const app = mount(env.state);
    const pre = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    await answerAll(app, env.learnerId, pre.body);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8 * DAY));
    const post = await call(app, "POST", "/a/start", { kind: "post", learnerId: env.learnerId });
    const preIds: string[] = pre.body.questions.map((q: { id: string }) => q.id);
    const postIds: string[] = post.body.questions.map((q: { id: string }) => q.id);
    // 只剩 2 道没见过的：它们排在最前，再拿前测题凑满，并如实标注
    expect(postIds.slice(0, 2).every((id) => !preIds.includes(id))).toBe(true);
    expect(post.body.reused).toBe(true);
    expect(new Set(postIds).size).toBe(postIds.length);
  });
});

describe("B-06：同一题不出现两次", () => {
  it("一道题挂在两个节点上，也只进卷一次", () => {
    const questions = [
      makeQuestion({ id: "shared", nodeIds: [NODE_A, NODE_B] }),
      makeQuestion({ id: "b-only", nodeIds: [NODE_B] }),
    ];
    const env = makeEnv(questions);
    const built = buildAssessment(env.store, env.repo, env.learnerId, { kind: "pre", scope: [NODE_A, NODE_B], count: 4 });
    const ids = built.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(["b-only", "shared"]);
  });
});

describe("B-04 / D-03：判不准不算对错；测评题算见过", () => {
  it("没有判卷器的题记为 correct=null，不进分母", async () => {
    const questions = Array.from({ length: 4 }, (_, i) => makeQuestion({ id: `a${i}`, nodeIds: [NODE_A] }));
    const noJudge = { judgeFor: () => undefined } as unknown as SubjectRegistry;
    const env = makeEnv(questions, { subjects: noJudge });
    const app = mount(env.state);
    const start = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    const fin = await answerAll(app, env.learnerId, start.body, "26");
    expect(fin.status).toBe(200);
    expect(fin.body.summary.answered).toBe(0);
    expect(fin.body.summary.pending).toBe(4);
    expect(fin.body.summary.rate).toBeNull();
    expect(fin.body.summary.items.every((i: { correct: unknown }) => i.correct === null)).toBe(true);
  });

  it("判得出的和判不准的混在一起：分母只算判得出的", async () => {
    const questions = Array.from({ length: 4 }, (_, i) => makeQuestion({ id: `a${i}`, nodeIds: [NODE_A], answer: "26" }));
    const env = makeEnv(questions);
    const app = mount(env.state);
    const start = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    const ids: string[] = start.body.questions.map((q: { id: string }) => q.id);
    for (const id of ids) {
      await call(app, "POST", `/a/${start.body.id}/answer`, { learnerId: env.learnerId, questionId: id, answer: "26" });
    }
    // 人为把一道标成判不准（与没有判卷器时路由写的留痕一致）
    env.repo.appendEvent(env.learnerId, "assessment_item_pending", { assessmentId: start.body.id, questionId: ids[0] });
    const fin = await call(app, "POST", `/a/${start.body.id}/finish`, { learnerId: env.learnerId });
    expect(fin.body.summary.answered).toBe(3);
    expect(fin.body.summary.correct).toBe(3);
    expect(fin.body.summary.rate).toBe(1);
  });

  it("assessmentSeenAt：作答过的取 answered_at，没作答的取开卷时间", async () => {
    const questions = Array.from({ length: 4 }, (_, i) => makeQuestion({ id: `a${i}`, nodeIds: [NODE_A] }));
    const env = makeEnv(questions);
    const app = mount(env.state);
    const start = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    const first = start.body.questions[0].id as string;
    await call(app, "POST", `/a/${start.body.id}/answer`, { learnerId: env.learnerId, questionId: first, answer: "1" });
    const seen = assessmentSeenAt(env.repo, env.learnerId);
    const items = env.repo.listAssessmentItems(start.body.id);
    expect(seen.size).toBe(4);
    expect(seen.get(first)).toBe(items.find((i) => i.questionId === first)!.answeredAt);
    const created = env.repo.getAssessment(start.body.id)!.createdAt;
    expect(seen.get(start.body.questions[1].id)).toBe(created);
  });
});

describe("B-04：下发视图带图与英文题面；缺图题不选", () => {
  it("figureImage / figure / stemEn / answerLang 都下发，答案不下发；figureMissing 的题不进卷", async () => {
    const questions = [
      makeQuestion({
        id: "fig",
        nodeIds: [NODE_A],
        figureImage: "fig.png",
        stemEn: "How many?",
        answerLang: "zh",
      } as Partial<Question> & { id: string }),
      makeQuestion({ id: "lost", nodeIds: [NODE_A], figureImage: "lost.png" } as Partial<Question> & { id: string }),
      makeQuestion({ id: "plain1", nodeIds: [NODE_A] }),
      makeQuestion({ id: "plain2", nodeIds: [NODE_A] }),
      makeQuestion({ id: "plain3", nodeIds: [NODE_A] }),
    ];
    const env = makeEnv(questions);
    env.store.figureMissing.add("lost");
    const app = mount(env.state);
    const start = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    const ids = start.body.questions.map((q: { id: string }) => q.id);
    expect(ids).not.toContain("lost");
    const fig = start.body.questions.find((q: { id: string }) => q.id === "fig");
    expect(fig.figureImage).toBe("fig.png");
    expect(fig.stemEn).toBe("How many?");
    expect(fig.answerLang).toBe("zh");
    expect(JSON.stringify(start.body)).not.toContain('"answer"');
  });
});

describe("B-07 / D-04：孩子本人做、按排期、只记第一次、至少答一半", () => {
  it("家长调用 /start、/answer、/finish → 403", async () => {
    const env = makeEnv(Array.from({ length: 4 }, (_, i) => makeQuestion({ id: `a${i}` })));
    const parentApp = mount(env.state, "parent");
    const res = await call(parentApp, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("孩子本人");
    expect(env.repo.listAssessments(env.learnerId)).toHaveLength(0);

    const childApp = mount(env.state);
    const start = await call(childApp, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId });
    const ans = await call(parentApp, "POST", `/a/${start.body.id}/answer`, {
      learnerId: env.learnerId,
      questionId: start.body.questions[0].id,
      answer: "26",
    });
    expect(ans.status).toBe(403);
    expect((await call(parentApp, "POST", `/a/${start.body.id}/finish`, { learnerId: env.learnerId })).status).toBe(403);
  });

  it("孩子会话正常开卷", async () => {
    const env = makeEnv(Array.from({ length: 4 }, (_, i) => makeQuestion({ id: `a${i}` })));
    const childApp = mount(env.state, "child", env.learnerId);
    // authDisabled 下 effectiveLearnerId 按请求值放行，所以这里显式带上 learnerId
    const res = await call(childApp, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId });
    expect(res.status).toBe(200);
  });

  it("没做前测就要后测 → 409；前测做完没满 7 天 → 409 带 dueAt；同一档做过 → 409", async () => {
    const env = makeEnv(Array.from({ length: 12 }, (_, i) => makeQuestion({ id: `a${i}` })));
    const app = mount(env.state);
    const early = await call(app, "POST", "/a/start", { kind: "post", learnerId: env.learnerId });
    expect(early.status).toBe(409);
    expect(early.body.error).toContain("前测");

    const pre = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    await answerAll(app, env.learnerId, pre.body);

    const again = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("只做一次");

    const notDue = await call(app, "POST", "/a/start", { kind: "post", learnerId: env.learnerId });
    expect(notDue.status).toBe(409);
    expect(notDue.body.dueAt).toBeTruthy();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8 * DAY));
    expect((await call(app, "POST", "/a/start", { kind: "post", learnerId: env.learnerId })).status).toBe(200);
  });

  it("开过没交卷的同档测评：再点开始是续做同一份，不另开", async () => {
    const env = makeEnv(Array.from({ length: 8 }, (_, i) => makeQuestion({ id: `a${i}` })));
    const app = mount(env.state);
    const a = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    const b = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.resumed).toBe(true);
    expect(env.repo.listAssessments(env.learnerId)).toHaveLength(1);
  });

  it("同一道题第二次作答 → 409，第一次的答案不被覆盖", async () => {
    const env = makeEnv(Array.from({ length: 4 }, (_, i) => makeQuestion({ id: `a${i}`, answer: "26" })));
    const app = mount(env.state);
    const start = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId });
    const qid = start.body.questions[0].id;
    const first = await call(app, "POST", `/a/${start.body.id}/answer`, { learnerId: env.learnerId, questionId: qid, answer: "1" });
    expect(first.status).toBe(200);
    const second = await call(app, "POST", `/a/${start.body.id}/answer`, { learnerId: env.learnerId, questionId: qid, answer: "26" });
    expect(second.status).toBe(409);
    const item = env.repo.listAssessmentItems(start.body.id).find((i) => i.questionId === qid)!;
    expect(item.answer).toBe("1");
    expect(item.correct).toBe(false);
  });

  it("零作答 / 不到一半就交卷 → 409，话术说清要答多少", async () => {
    const env = makeEnv(Array.from({ length: 4 }, (_, i) => makeQuestion({ id: `a${i}` })));
    const app = mount(env.state);
    const start = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    const zero = await call(app, "POST", `/a/${start.body.id}/finish`, { learnerId: env.learnerId });
    expect(zero.status).toBe(409);
    expect(zero.body.error).toContain("至少答完一半");
    expect(zero.body.need).toBe(2);
    expect(env.repo.getAssessment(start.body.id)!.finishedAt).toBeNull();

    await call(app, "POST", `/a/${start.body.id}/answer`, {
      learnerId: env.learnerId,
      questionId: start.body.questions[0].id,
      answer: "1",
    });
    expect((await call(app, "POST", `/a/${start.body.id}/finish`, { learnerId: env.learnerId })).status).toBe(409);
    await call(app, "POST", `/a/${start.body.id}/answer`, {
      learnerId: env.learnerId,
      questionId: start.body.questions[1].id,
      answer: "不会",
    });
    expect((await call(app, "POST", `/a/${start.body.id}/finish`, { learnerId: env.learnerId })).status).toBe(200);
  });
});

describe("E-02：英语（词汇 + 阅读）的前后测", () => {
  const vocabulary = loadVocabulary();
  const reading = loadReading();

  it("英语前测：6 个词（英→中）+ 每篇阅读 1 题，id 带前缀，答案不下发", async () => {
    const env = makeEnv([makeQuestion({ id: "m0" })]);
    const app = mount(env.state);
    const start = await call(app, "POST", "/a/start", { kind: "pre", subject: "english", learnerId: env.learnerId });
    expect(start.status).toBe(200);
    expect(start.body.subject).toBe("english");
    const ids: string[] = start.body.questions.map((q: { id: string }) => q.id);
    expect(ids.filter((id) => id.startsWith("vocab:"))).toHaveLength(ENGLISH_VOCAB_COUNT);
    const readingIds = ids.filter((id) => id.startsWith("reading:"));
    expect(readingIds).toHaveLength(Math.min(ENGLISH_READING_PASSAGES, reading.passages.length));
    expect(new Set(readingIds.map((id) => id.split(":")[1])).size).toBe(readingIds.length);
    const readingItem = start.body.questions.find((q: { id: string }) => q.id.startsWith("reading:"));
    expect(readingItem.passage.text.length).toBeGreaterThan(0);
    const raw = JSON.stringify(start.body);
    expect(raw).not.toContain('"answer"');
    expect(raw).not.toContain('"evidence"');
  });

  it("英语判卷复用 judgeVocab / judgeReading，交卷按词汇/阅读分开统计", async () => {
    const env = makeEnv([makeQuestion({ id: "m0" })]);
    const app = mount(env.state);
    const start = await call(app, "POST", "/a/start", { kind: "pre", subject: "english", learnerId: env.learnerId });
    for (const q of start.body.questions as { id: string }[]) {
      let answer = "不会";
      if (q.id.startsWith("vocab:")) answer = vocabulary.find((c) => `vocab:${c.id}` === q.id)!.zh.split("/")[0]!;
      await call(app, "POST", `/a/${start.body.id}/answer`, { learnerId: env.learnerId, questionId: q.id, answer });
    }
    const fin = await call(app, "POST", `/a/${start.body.id}/finish`, { learnerId: env.learnerId });
    expect(fin.status).toBe(200);
    const byNode = Object.fromEntries(
      (fin.body.summary.byNode as { nodeId: string; correct: number; total: number }[]).map((n) => [n.nodeId, n]),
    );
    expect(byNode["english:vocab"]).toEqual({ nodeId: "english:vocab", correct: ENGLISH_VOCAB_COUNT, total: ENGLISH_VOCAB_COUNT });
    expect(byNode["english:reading"].correct).toBe(0);
    expect(fin.body.summary.items.every((i: { reference: string }) => i.reference.length > 0)).toBe(true);
  });

  it("英语后测不重发前测的词与阅读题；英语排期与数学独立", async () => {
    const env = makeEnv(Array.from({ length: 4 }, (_, i) => makeQuestion({ id: `m${i}` })));
    const app = mount(env.state);
    const pre = await call(app, "POST", "/a/start", { kind: "pre", subject: "english", learnerId: env.learnerId });
    await answerAll(app, env.learnerId, pre.body);
    // 数学还没做过前测：英语做完前测不影响数学从前测开始
    expect((await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId })).status).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8 * DAY));
    const post = await call(app, "POST", "/a/start", { kind: "post", subject: "english", learnerId: env.learnerId });
    expect(post.status).toBe(200);
    const preIds = new Set(pre.body.questions.map((q: { id: string }) => q.id));
    const vocabOverlap = post.body.questions.filter((q: { id: string }) => q.id.startsWith("vocab:") && preIds.has(q.id));
    expect(vocabOverlap).toHaveLength(0);
    // 读物每篇题多于 1 道时，阅读题也换新的
    const multi = reading.passages.slice(0, ENGLISH_READING_PASSAGES).every((p) => p.questions.length > 1);
    if (multi) {
      expect(post.body.questions.filter((q: { id: string }) => q.id.startsWith("reading:") && preIds.has(q.id))).toHaveLength(0);
    }
  });

  it("buildEnglishAssessment：学过的词最多占一半", () => {
    const env = makeEnv([makeQuestion({ id: "m0" })]);
    for (const card of vocabulary.slice(10, 20)) {
      env.repo.upsertReviewCard(env.learnerId, "vocab", card.id, new Date(Date.now() + DAY).toISOString());
    }
    const built = buildEnglishAssessment(env.repo, env.learnerId, vocabulary, reading);
    const learned = new Set(vocabulary.slice(10, 20).map((c) => `vocab:${c.id}`));
    const vocabIds = built.items.filter((i) => i.id.startsWith("vocab:")).map((i) => i.id);
    expect(vocabIds).toHaveLength(ENGLISH_VOCAB_COUNT);
    expect(vocabIds.filter((id) => learned.has(id))).toHaveLength(ENGLISH_VOCAB_COUNT / 2);
  });

  it("英语模块被家长关掉时英语测评开不了", async () => {
    const env = makeEnv([makeQuestion({ id: "m0" })]);
    const { writeModules } = await import("../src/modules.js");
    writeModules(env.repo, env.learnerId, { english: false });
    const app = mount(env.state);
    const res = await call(app, "POST", "/a/start", { kind: "pre", subject: "english", learnerId: env.learnerId });
    expect(res.status).toBe(403);
  });

  it("家长端 /assessments 按学科分开对比，顶层保持数学口径", async () => {
    const env = makeEnv(Array.from({ length: 8 }, (_, i) => makeQuestion({ id: `m${i}` })));
    const app = mount(env.state);
    const mathPre = await call(app, "POST", "/a/start", { kind: "pre", learnerId: env.learnerId, count: 4 });
    await answerAll(app, env.learnerId, mathPre.body, "26");
    const enPre = await call(app, "POST", "/a/start", { kind: "pre", subject: "english", learnerId: env.learnerId });
    await answerAll(app, env.learnerId, enPre.body);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 8 * DAY));
    const enPost = await call(app, "POST", "/a/start", { kind: "post", subject: "english", learnerId: env.learnerId });
    await answerAll(app, env.learnerId, enPost.body);

    const res = await env.app.request(`/api/v1/parent/assessments?learnerId=${env.learnerId}`);
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.sessions).toHaveLength(3);
    expect(body.sessions.filter((s: { subject: string }) => s.subject === "english")).toHaveLength(2);
    // 数学只有前测：数学对比为空；英语前→后有对比，节点只在英语伪节点上
    expect(body.preToPost).toBeNull();
    expect(body.bySubject.math.preToPost).toBeNull();
    expect(body.bySubject.math.next.kind).toBe("post");
    const en = body.bySubject.english.preToPost;
    expect(en).not.toBeNull();
    expect(en.nodes.map((n: { nodeId: string }) => n.nodeId).sort()).toEqual(["english:reading", "english:vocab"]);
    expect(body.bySubject.english.next.kind).toBe("retention");
  });
});
