import { describe, expect, it } from "vitest";
import { MASTERY_PARAMS } from "@mathtutor/schema";
import { applyAttempt, masteryBand, litByEvidence } from "../src/mastery.js";
import { evidenceStatsByNode, type EvidenceAttempt } from "../src/evidence.js";
import { buildIndependenceReport } from "../src/independence.js";
import { looksLikeGiveUp } from "../src/routes/practice.js";
import { makeApp, makeQuestion, NODE_A, NODE_B } from "./helpers.js";

/**
 * 对抗审查 practice-evidence 区域的回归：
 * 每一条都对应一个"证据从侧门进了掌握度/点亮"的具体洞（编号见 describe）。
 */

async function post(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const base = { source: "daily", verification: "executable", needsReview: false, actor: "child" } as const;

describe("A-03 提示级按服务端账本记，不信客户端自报", () => {
  it("要过两级提示、提交时报 0：attempt 记 2，增益按 2 级折扣，不请他讲思路，不算独立证据", async () => {
    const { app, repo, store } = makeApp([makeQuestion({ id: "h1", answer: "7" })]);
    const learner = repo.createLearner("提示生", "elementary_upper");
    for (const level of [1, 2]) {
      const hint = await post(app, "/api/v1/practice/hint", { learnerId: learner.id, questionId: "h1", level });
      expect(hint.status).toBe(200);
    }
    const res = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id,
      questionId: "h1",
      answer: "7",
      hintLevelUsed: 0,
    });
    expect(res.body.correct).toBe(true);
    expect(res.body.countedTowardMastery).toBe(true);
    expect(repo.getAttempt(res.body.attemptId)?.hintLevelUsed).toBe(2);
    expect(res.body.askWhy).toBe(false);
    const expected = applyAttempt(undefined, true, 2).p;
    expect(repo.getMastery(learner.id, NODE_A)!.p).toBeCloseTo(expected, 6);
    // 下游证据读 attempt 列：用过提示就不是独立证据
    const stats = evidenceStatsByNode(repo.attemptsForEvidence(learner.id), store, new Map()).get(NODE_A)!;
    expect(stats.independent).toBe(0);
  });

  it("客户端报的比账本高时取客户端的（只往严里取）", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "h2", answer: "7" })]);
    const learner = repo.createLearner("自报生", "elementary_upper");
    const res = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id,
      questionId: "h2",
      answer: "7",
      hintLevelUsed: 1,
    });
    expect(repo.getAttempt(res.body.attemptId)?.hintLevelUsed).toBe(1);
  });

  it("/submit-photo 同样按账本取提示级", async () => {
    const env = makeApp([makeQuestion({ id: "h3", answer: "26" })]);
    env.state.photoGrader = { extractAnswer: async () => ({ answer: "26", confident: true }) };
    const learner = env.repo.createLearner("拍照提示生", "elementary_upper");
    for (const level of [1, 2, 3]) {
      await post(env.app, "/api/v1/practice/hint", { learnerId: learner.id, questionId: "h3", level });
    }
    const res = await post(env.app, "/api/v1/practice/submit-photo", {
      learnerId: learner.id,
      questionId: "h3",
      image: "aGVsbG8=",
      hintLevelUsed: 0,
    });
    expect(res.status).toBe(200);
    expect(env.repo.getAttempt(res.body.attemptId)?.hintLevelUsed).toBe(3);
  });

  it("账本只算这一轮：答对之后再做、或隔了 12 小时以上，不背旧提示", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "h4", answer: "7" })]);
    const learner = repo.createLearner("复习生", "elementary_upper");
    for (const level of [1, 2, 3]) {
      await post(app, "/api/v1/practice/hint", { learnerId: learner.id, questionId: "h4", level });
    }
    expect(repo.hintLevelThisRound(learner.id, "h4")).toBe(3);
    // 一周后复习：窗口外的提示不算
    expect(repo.hintLevelThisRound(learner.id, "h4", new Date(Date.now() + 7 * 86_400_000))).toBe(0);
    // 讲解闸用的全量口径不受影响：走过一遍就是走过
    expect(repo.maxHintLevel(learner.id, "h4")).toBe(3);

    // 同一轮里答对，之后马上重做：从零提示算起
    const first = await post(app, "/api/v1/practice/submit", { learnerId: learner.id, questionId: "h4", answer: "7" });
    expect(repo.getAttempt(first.body.attemptId)?.hintLevelUsed).toBe(3);
    await new Promise((r) => setTimeout(r, 5));
    expect(repo.hintLevelThisRound(learner.id, "h4")).toBe(0);
  });
});

describe("A-04 放弃判定按结构，且在语义判卷之前", () => {
  it("数值题：答案里一个数字、一个字母都没有 → 不是作答", () => {
    const q = { answer: "26", answerType: "numeric" as const };
    expect(looksLikeGiveUp("这题好怪", q)).toBe(true);
    expect(looksLikeGiveUp("我真的想不出来", q)).toBe(true);
    expect(looksLikeGiveUp("等会再说吧", q)).toBe(true);
    // 真答案不误伤：阿拉伯数字、中文数字、字母变量、数学记号
    expect(looksLikeGiveUp("26", q)).toBe(false);
    expect(looksLikeGiveUp("二十六", q)).toBe(false);
    expect(looksLikeGiveUp("一半", { answer: "1/2", answerType: "expression" })).toBe(false);
    expect(looksLikeGiveUp("x+1", { answer: "x+1", answerType: "expression" })).toBe(false);
    expect(looksLikeGiveUp("π", { answer: "π", answerType: "expression" })).toBe(false);
  });

  it("参考答案里含数字（即使类型是 steps）也适用；纯文字参考答案的 steps 题不适用", () => {
    expect(looksLikeGiveUp("不清楚呢", { answer: "先算 3×4=12", answerType: "steps" })).toBe(true);
    expect(looksLikeGiveUp("我的思路是先加后减", { answer: "先加后减", answerType: "steps" })).toBe(false);
  });

  it("英语题不用数字规则：只认短语表与全是标点/emoji", () => {
    const en = { answer: "three quarters", answerType: "expression" as const, answerLang: "en" as const };
    expect(looksLikeGiveUp("three fourths", en)).toBe(false);
    expect(looksLikeGiveUp("不知道啊呀", en)).toBe(false);
    expect(looksLikeGiveUp("不会", en)).toBe(true);
    expect(looksLikeGiveUp("🙂🙂", en)).toBe(true);
    // 没声明 answerLang、但参考答案是纯英文单词，也按英语题处理
    expect(looksLikeGiveUp("苹果", { answer: "apple", answerType: "expression" })).toBe(false);
  });

  it("经 HTTP：判定在语义判卷之前，放弃话术不白花一次模型调用", async () => {
    let judgeCalls = 0;
    const { app, repo } = makeApp([makeQuestion({ id: "g1", answer: "26" })], {
      judge: async () => {
        judgeCalls++;
        return { verdict: "correct", why: "测试桩" };
      },
    });
    const learner = repo.createLearner("放弃生", "elementary_upper");
    const res = await post(app, "/api/v1/practice/submit", { learnerId: learner.id, questionId: "g1", answer: "这题好怪" });
    expect(res.body.notAnAnswer).toBe(true);
    expect(res.body.attemptId).toBeNull();
    expect(judgeCalls).toBe(0);
    expect(repo.attemptsForEvidence(learner.id)).toEqual([]);
  });
});

describe("B-01 家长裁决回填套用 /submit 的纪律", () => {
  it("被裁决的是家长试做 → 不进掌握度", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "v1", answer: "26" })]);
    const learner = repo.createLearner("裁决生", "elementary_upper");
    const attempt = repo.insertAttempt({
      learnerId: learner.id, questionId: "v1", answer: "26 个", correct: false,
      hintLevelUsed: 0, source: "daily", needsReview: true, actor: "parent",
    });
    const res = await post(app, "/api/v1/parent/verdict", { attemptId: attempt.id, verdict: "correct" });
    expect(res.body.ok).toBe(true);
    expect(res.body.countedTowardMastery).toBe(false);
    expect(res.body.mastery).toEqual([]);
    expect(repo.getMastery(learner.id, NODE_A)).toBeUndefined();
  });

  it("作答那天同一道题已有计入的同向证据 → 不再加", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "v2", answer: "26" })]);
    const learner = repo.createLearner("同日生", "elementary_upper");
    const t0 = Date.now() - 2000;
    // 先交了一个判得准的对答案（已计入），又交了一个判不准的
    const first = await post(app, "/api/v1/practice/submit", { learnerId: learner.id, questionId: "v2", answer: "26" });
    expect(first.body.countedTowardMastery).toBe(true);
    const before = repo.getMastery(learner.id, NODE_A)!;
    const pendingAttempt = repo.insertAttempt({
      learnerId: learner.id, questionId: "v2", answer: "二十六个", correct: false,
      hintLevelUsed: 0, source: "daily", needsReview: true, at: new Date(t0 + 1000).toISOString(),
    });
    const res = await post(app, "/api/v1/parent/verdict", { attemptId: pendingAttempt.id, verdict: "correct" });
    expect(res.body.countedTowardMastery).toBe(false);
    const after = repo.getMastery(learner.id, NODE_A)!;
    expect(after.evidenceN).toBe(before.evidenceN);
    expect(after.p).toBeCloseTo(before.p, 9);
  });

  it("看过解析打折、次节点只沾一半：和 /submit 同一份算法", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "v3", answer: "26", nodeIds: [NODE_A, NODE_B] })]);
    const learner = repo.createLearner("折扣生", "elementary_upper");
    repo.appendEvent(learner.id, "analysis_view", { questionId: "v3" });
    const attempt = repo.insertAttempt({
      learnerId: learner.id, questionId: "v3", answer: "二十六", correct: false,
      hintLevelUsed: 1, source: "daily", needsReview: true, at: new Date(Date.now() + 1000).toISOString(),
    });
    const res = await post(app, "/api/v1/parent/verdict", { attemptId: attempt.id, verdict: "correct" });
    expect(res.body.countedTowardMastery).toBe(true);
    const f = MASTERY_PARAMS.afterAnalysisGainFactor;
    expect(repo.getMastery(learner.id, NODE_A)!.p).toBeCloseTo(applyAttempt(undefined, true, 1, f).p, 9);
    expect(repo.getMastery(learner.id, NODE_B)!.p).toBeCloseTo(applyAttempt(undefined, true, 1, f * 0.5).p, 9);
  });
});

describe("B-02 拿不到证据统计 = 零独立证据，不点亮", () => {
  it("masteryBand 缺 stats 时最多到微光", () => {
    expect(masteryBand(0.95, 10, undefined)).toBe("glow");
    expect(masteryBand(0.2, 10, undefined)).toBe("dim");
  });

  it("p 很高但一条独立证据都没有：/next-step 仍把它当没点亮的节点", async () => {
    const { app, repo } = makeApp([makeQuestion({ id: "b1", answer: "26" })]);
    const learner = repo.createLearner("无证生", "elementary_upper");
    repo.upsertMastery({ learnerId: learner.id, nodeId: NODE_A, p: 0.95, evidenceN: 10, lastEvidenceAt: new Date().toISOString() });
    const res = await app.request(`/api/v1/practice/next-step?learnerId=${learner.id}`);
    const body = await res.json();
    expect(body.kind).toBe("weak");
    expect(body.nodeId).toBe(NODE_A);
  });
});

describe("B-03 探针回填：队列项要归属本人、是探针、未消费；只回填一次", () => {
  function setup() {
    const env = makeApp([makeQuestion({ id: "pr1", answer: "5" }), makeQuestion({ id: "pr2", answer: "6" })]);
    const learner = env.repo.createLearner("探针生", "elementary_upper");
    const other = env.repo.createLearner("别人家", "elementary_upper");
    return { ...env, learner, other };
  }
  const past = () => new Date(Date.now() - 1000).toISOString();

  it("同一探针队列项重试：第二次当 daily，不再回填归因证据", async () => {
    const { app, repo, learner } = setup();
    repo.insertMistake({
      id: "m-probe", attemptId: "a0", learnerId: learner.id, questionId: "pr2", surface: "concept",
      rootNodeId: NODE_A, chain: [NODE_A], confidence: 0.5, eligible: false,
    });
    const queueId = repo.pushQueueItem(learner.id, "probe", "pr1", past());
    const first = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id, questionId: "pr1", answer: "5", queueItemId: queueId,
    });
    expect(repo.getAttempt(first.body.attemptId)?.source).toBe("probe");
    const afterFirst = repo.getMistake("m-probe")!.confidence;
    expect(afterFirst).toBeLessThan(0.5);

    const retry = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id, questionId: "pr1", answer: "4", queueItemId: queueId,
    });
    expect(repo.getAttempt(retry.body.attemptId)?.source).toBe("daily");
    expect(repo.getMistake("m-probe")!.confidence).toBeCloseTo(afterFirst, 9);
    expect(repo.listEvents(learner.id, "probe_result").length).toBe(1);
  });

  it("别人的队列项：当 daily，且不替别人消费掉", async () => {
    const { app, repo, learner, other } = setup();
    const foreign = repo.pushQueueItem(other.id, "probe", "pr1", past());
    const res = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id, questionId: "pr1", answer: "5", queueItemId: foreign,
    });
    expect(repo.getAttempt(res.body.attemptId)?.source).toBe("daily");
    expect(repo.getQueueItemState(foreign)?.consumedAt).toBeNull();
  });

  it("不是探针（复习队列项）、或探针对不上这道题：都当 daily", async () => {
    const { app, repo, learner } = setup();
    const review = repo.pushQueueItem(learner.id, "review", "pr1", past());
    const r1 = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id, questionId: "pr1", answer: "5", queueItemId: review, source: "probe",
    });
    expect(repo.getAttempt(r1.body.attemptId)?.source).toBe("daily");
    const probeForOther = repo.pushQueueItem(learner.id, "probe", "pr1", past());
    const r2 = await post(app, "/api/v1/practice/submit", {
      learnerId: learner.id, questionId: "pr2", answer: "6", queueItemId: probeForOther,
    });
    expect(repo.getAttempt(r2.body.attemptId)?.source).toBe("daily");
  });
});

describe("B-05 独立证据只算首见那一次", () => {
  const questions = {
    byId: new Map([
      ["a", { nodeIds: ["n1"] }],
      ["b", { nodeIds: ["n1"] }],
      ["c", { nodeIds: ["n1"] }],
    ]),
  };

  it("一道首见题 + 两道早就见过、隔天再做对的旧题：凑不出点亮", () => {
    const attempts: EvidenceAttempt[] = [
      { ...base, questionId: "a", correct: true, hintLevelUsed: 0, at: "2026-11-01T09:00:00.000Z" },
      { ...base, questionId: "b", correct: false, hintLevelUsed: 0, at: "2026-11-01T09:10:00.000Z" },
      { ...base, questionId: "c", correct: false, hintLevelUsed: 0, at: "2026-11-01T09:20:00.000Z" },
      { ...base, questionId: "b", correct: true, hintLevelUsed: 0, at: "2026-11-02T09:00:00.000Z" },
      { ...base, questionId: "c", correct: true, hintLevelUsed: 0, at: "2026-11-03T09:00:00.000Z" },
    ];
    const s = evidenceStatsByNode(attempts, questions, new Map()).get("n1")!;
    expect(s.independent).toBe(1);
    expect(s.distinctQuestions).toBe(1);
    expect(litByEvidence(s)).toBe(false);
    expect(masteryBand(0.9, 5, s)).not.toBe("lit");
  });

  it("三道不同的首见题、隔天、零提示做对 → 点亮（门槛没被抬到做不到）", () => {
    const attempts: EvidenceAttempt[] = [
      { ...base, questionId: "a", correct: true, hintLevelUsed: 0, at: "2026-11-01T09:00:00.000Z" },
      { ...base, questionId: "b", correct: true, hintLevelUsed: 0, at: "2026-11-02T09:00:00.000Z" },
      { ...base, questionId: "c", correct: true, hintLevelUsed: 0, at: "2026-11-03T09:00:00.000Z" },
    ];
    const s = evidenceStatsByNode(attempts, questions, new Map()).get("n1")!;
    expect(s.independent).toBe(3);
    expect(litByEvidence(s)).toBe(true);
  });

  it("首见那次用了提示（attempt 列）：之后零提示做对也不算独立", () => {
    const attempts: EvidenceAttempt[] = [
      { ...base, questionId: "a", correct: true, hintLevelUsed: 2, at: "2026-11-01T09:00:00.000Z" },
      { ...base, questionId: "a", correct: true, hintLevelUsed: 0, at: "2026-11-02T09:00:00.000Z" },
    ];
    const s = evidenceStatsByNode(attempts, questions, new Map()).get("n1")!;
    expect(s.independent).toBe(0);
  });

  it("测评里见过的题（交卷还看了参考答案）：之后练习零提示做对也不算首见", () => {
    const attempts: EvidenceAttempt[] = [
      { ...base, questionId: "a", correct: true, hintLevelUsed: 0, at: "2026-11-05T09:00:00.000Z" },
      { ...base, questionId: "b", correct: true, hintLevelUsed: 0, at: "2026-11-06T09:00:00.000Z" },
    ];
    const seenInAssessment = new Map([["a", "2026-11-01T09:00:00.000Z"]]);
    const s = evidenceStatsByNode(attempts, questions, new Map(), seenInAssessment).get("n1")!;
    expect(s.independent).toBe(1);
    expect(s.distinctQuestions).toBe(1);
  });
});

describe("B-08 拍照作答：参考答案未核对的题进家长抽检", () => {
  it("practiceReady=false → needsReview，出现在待裁决里，不进掌握度", async () => {
    const env = makeApp([
      makeQuestion({ id: "u1", answer: "26", answerUnverified: true, status: "extracted" }),
    ]);
    env.state.photoGrader = { extractAnswer: async () => ({ answer: "26", confident: true }) };
    const learner = env.repo.createLearner("拍照抽检生", "elementary_upper");
    const res = await post(env.app, "/api/v1/practice/submit-photo", {
      learnerId: learner.id,
      questionId: "u1",
      image: "aGVsbG8=",
    });
    expect(res.status).toBe(200);
    expect(res.body.needsReview).toBe(true);
    expect(res.body.countedTowardMastery).toBe(false);
    expect(env.repo.getAttempt(res.body.attemptId)?.needsReview).toBe(true);
    expect(env.repo.getMastery(learner.id, NODE_A)).toBeUndefined();
  });
});

describe("G-01 独立性报告：先用全部作答定首见，再过滤计数", () => {
  it("首见那次在抽检中、隔天才认真做对：不算'第一次见就做对'", () => {
    const report = buildIndependenceReport({
      attempts: [
        { ...base, questionId: "q", correct: false, hintLevelUsed: 0, at: "2026-11-01T09:00:00.000Z", needsReview: true },
        { ...base, questionId: "q", correct: true, hintLevelUsed: 0, at: "2026-11-02T09:00:00.000Z" },
      ],
      questions: { byId: new Map([["q", { nodeIds: ["n1"] }]]) },
      analysisViews: new Map(),
      askCount: 0,
      repeats: 0,
      reflections: { selfExplain: 0, errorGuess: 0 },
    });
    expect(report.firstSeenQuestions).toBe(0);
    expect(report.independentFirstCorrect).toBe(0);
    expect(report.independentRate).toBeNull();
    // 计数照旧只算算数的那条
    expect(report.attempts).toBe(1);
  });

  it("家长先试做过这道题：孩子后来那次也不再是首见（与 evidence 同口径）", () => {
    const report = buildIndependenceReport({
      attempts: [
        { ...base, questionId: "q", correct: true, hintLevelUsed: 0, at: "2026-11-01T09:00:00.000Z", actor: "parent" },
        { ...base, questionId: "q", correct: true, hintLevelUsed: 0, at: "2026-11-01T10:00:00.000Z" },
      ],
      questions: { byId: new Map([["q", { nodeIds: ["n1"] }]]) },
      analysisViews: new Map(),
      askCount: 0,
      repeats: 0,
      reflections: { selfExplain: 0, errorGuess: 0 },
    });
    expect(report.firstSeenQuestions).toBe(0);
  });
});
