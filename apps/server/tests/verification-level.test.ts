import { describe, expect, it } from "vitest";
import { countsTowardMastery } from "../src/mastery.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";

/**
 * 宪法第 5 条落地检查：未经验证的证据不承重。
 *
 * 数学判卷今天全是 executable，所以这条现在"看不出来"——正因为它看不出来，
 * 才更要在类型和存储两层都锁住：等英语作文进来那天，靠的是这些断言，
 * 而不是谁记得。
 */
describe("证据的验证等级", () => {
  it("只有 ai_unverified 不进掌握度", () => {
    expect(countsTowardMastery("executable")).toBe(true);
    expect(countsTowardMastery("reference")).toBe(true);
    expect(countsTowardMastery("ai_unverified")).toBe(false);
  });

  it("存储层原样保留等级（默认 executable，显式传 ai_unverified 也能读回）", () => {
    const repo = new Repo(openMemoryDb());
    const learner = repo.createLearner("点点", "elementary_upper");

    const plain = repo.insertAttempt({
      learnerId: learner.id,
      questionId: "q1",
      answer: "26",
      correct: true,
      hintLevelUsed: 0,
      source: "daily",
      needsReview: false,
    });
    expect(plain.verification).toBe("executable");
    expect(repo.getAttempt(plain.id)?.verification).toBe("executable");

    const essay = repo.insertAttempt({
      learnerId: learner.id,
      questionId: "q2",
      answer: "My favourite season is spring.",
      correct: true,
      hintLevelUsed: 0,
      source: "daily",
      needsReview: false,
      verification: "ai_unverified",
    });
    expect(repo.getAttempt(essay.id)?.verification).toBe("ai_unverified");
  });
});
