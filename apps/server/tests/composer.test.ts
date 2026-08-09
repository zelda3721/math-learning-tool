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
