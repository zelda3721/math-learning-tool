import { describe, expect, it } from "vitest";
import { composeToday } from "../src/composer.js";
import { knowledge, makeQuestion, tempFixtureEnv, NODE_A, NODE_B } from "./helpers.js";

describe("composeToday minimal composer", () => {
  it("prioritizes weak nodes over new, excludes recently correct, appends challenge", () => {
    const questions = [
      makeQuestion({ id: "qa1", nodeIds: [NODE_A], stem: "弱点题1", answer: "1" }),
      makeQuestion({ id: "qa2", nodeIds: [NODE_A], stem: "弱点题2", answer: "2" }),
      makeQuestion({ id: "qb1", nodeIds: [NODE_B], stem: "新题1", answer: "3" }),
      makeQuestion({ id: "qc1", stem: "挑战题", answer: "4", difficulty: 4 }),
      makeQuestion({ id: "qd1", nodeIds: [NODE_B], stem: "做对过的题", answer: "5" }),
    ];
    const { store, repo } = tempFixtureEnv(questions);
    const learner = repo.createLearner("小明", "elementary_upper");

    // NODE_A 掌握度低（弱点）；qd1 三天内做对过（应排除）
    repo.upsertMastery({
      learnerId: learner.id,
      nodeId: NODE_A,
      p: 0.2,
      evidenceN: 2,
      lastEvidenceAt: new Date().toISOString(),
    });
    repo.insertAttempt({
      learnerId: learner.id,
      questionId: "qd1",
      answer: "5",
      correct: true,
      hintLevelUsed: 0,
      source: "daily",
      needsReview: false,
    });

    const composed = composeToday(store, knowledge.index, repo, learner.id, { count: 4 });
    const ids = composed.map((c) => c.question.id);
    expect(ids).not.toContain("qd1");
    // 弱点题排在新题前
    expect(ids.indexOf("qa1")).toBeLessThan(ids.indexOf("qb1"));
    // 挑战题在末尾
    expect(composed[composed.length - 1]!.slot).toBe("challenge");
    expect(ids).toContain("qc1");
  });

  it("queue items come first", () => {
    const questions = [
      makeQuestion({ id: "queued", stem: "队列题", answer: "1" }),
      makeQuestion({ id: "fresh", nodeIds: [NODE_B], stem: "新题", answer: "2" }),
    ];
    const { store, repo } = tempFixtureEnv(questions);
    const learner = repo.createLearner("小红", "elementary_upper");
    const queueItemId = repo.pushQueueItem(
      learner.id,
      "probe",
      "queued",
      new Date(Date.now() - 1000).toISOString(),
    );

    const composed = composeToday(store, knowledge.index, repo, learner.id, { count: 3, challenge: false });
    expect(composed[0]!.question.id).toBe("queued");
    expect(composed[0]!.slot).toBe("queue");
    expect(composed[0]!.queueItemId).toBe(queueItemId);
  });
});

/**
 * 「弱点」这个词要诚实。
 *
 * 曾把"有证据且未点亮"一律标成 weak：点亮要 p≥0.7 且 ≥3 次作答，
 * 孩子第一次做对后 p≈0.55、证据 1 次——不亮，于是被标弱点。
 * 第一次练习之后几乎每道题都顶着红色的弱点徽章，做对了反而挨标。
 */
describe("槽位标签描述孩子和这道题的关系", () => {
  /**
   * 规则：新题=这道题没做过（哪怕知识点摸过）；
   * 弱点/巩固只贴在**重做过的题**上，按知识点档位分。
   * 走过两版弯路：先是"未点亮一律弱点"（做对一次反而挨红标），
   * 后是"知识点摸过就巩固"（一道没见过的题顶着巩固的帽子）。
   */
  function seed(p: number, withAttempt: boolean) {
    const { store, repo } = tempFixtureEnv([
      makeQuestion({ id: "q1", nodeIds: [NODE_A], stem: "题一", answer: "1" }),
    ]);
    const learner = repo.createLearner("小明", "elementary_upper");
    repo.upsertMastery({
      learnerId: learner.id,
      nodeId: NODE_A,
      p,
      evidenceN: 2,
      lastEvidenceAt: new Date().toISOString(),
    });
    if (withAttempt) {
      // 一周前做错过这道题（近三天做对的会被排除，做错的不会）
      repo.insertAttempt({
        learnerId: learner.id,
        questionId: "q1",
        answer: "9",
        correct: false,
        hintLevelUsed: 0,
        source: "daily",
        needsReview: false,
      });
    }
    return { store, repo, learner };
  }
  const slotOf = (env: ReturnType<typeof seed>) =>
    composeToday(env.store, knowledge.index, env.repo, env.learner.id, { count: 3, challenge: false })[0]!.slot;

  it("没做过的题就是新题——哪怕知识点很弱", () => {
    expect(slotOf(seed(0.25, false))).toBe("new");
  });

  it("没做过的题也不是巩固——哪怕知识点摸过", () => {
    expect(slotOf(seed(0.55, false))).toBe("new");
  });

  it("重做过且知识点真弱 → 弱点", () => {
    expect(slotOf(seed(0.25, true))).toBe("weak");
  });

  it("重做过且知识点摸过没点亮 → 巩固", () => {
    expect(slotOf(seed(0.55, true))).toBe("consolidate");
  });
});
