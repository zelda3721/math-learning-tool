import { describe, expect, it } from "vitest";
import { planToday, nextLesson } from "../src/planner.js";
import { makeApp, makeQuestion, NODE_A } from "./helpers.js";

/**
 * 每日规划器：把"今天还剩多少分钟"变成"今天做什么"。
 *
 * 锁住的是三件事：复习优先、预算不超、没内容的档不出现。
 */

const q = (id: string, nodeIds = [NODE_A]) => makeQuestion({ id, nodeIds, stem: `题 ${id}`, answer: "1" });

describe("每天怎么排", () => {
  it("有到期复习就先排复习", () => {
    const { repo, state } = makeApp([q("q1")]);
    const learner = repo.createLearner("小测", "elementary_upper");
    const now = new Date().toISOString();
    repo.upsertReviewCard(learner.id, "question", "q1", now);

    const plan = planToday({
      repo,
      index: state.knowledge.index,
      store: state.questions,
      learnerId: learner.id,
      budgetMinutes: 30,
    });
    expect(plan.blocks[0]?.kind).toBe("review");
    expect(plan.blocks[0]?.title).toContain("复习");
  });

  it("预算不超：各块加起来 ≤ 可用时间", () => {
    for (const budget of [5, 12, 30, 60]) {
      const { repo, state } = makeApp([q("q1")]);
      const learner = repo.createLearner("小测", "elementary_upper");
      repo.upsertReviewCard(learner.id, "question", "q1", new Date().toISOString());
      const plan = planToday({
        repo, index: state.knowledge.index, store: state.questions,
        learnerId: learner.id, budgetMinutes: budget,
      });
      const sum = plan.blocks.reduce((s, b) => s + b.minutes, 0);
      expect(sum, `预算 ${budget}`).toBeLessThanOrEqual(budget);
      expect(plan.leftMinutes).toBeGreaterThanOrEqual(0);
    }
  });

  it("时间用完了：不给一张空表，给一句能读懂的话", () => {
    const { repo, state } = makeApp([q("q1")]);
    const learner = repo.createLearner("小测", "elementary_upper");
    const plan = planToday({
      repo, index: state.knowledge.index, store: state.questions,
      learnerId: learner.id, budgetMinutes: 0,
    });
    expect(plan.blocks).toEqual([]);
    expect(plan.note).toContain("明天");
  });

  it("没有题材库的节点不排新课（点了没反应比没有计划更糟）", () => {
    const { repo, state } = makeApp([]); // 题库空
    const learner = repo.createLearner("小测", "elementary_upper");
    const plan = planToday({
      repo, index: state.knowledge.index, store: state.questions,
      learnerId: learner.id, budgetMinutes: 30,
    });
    expect(plan.blocks.some((b) => b.kind === "lesson")).toBe(false);
  });

  it("时间很紧时先保复习和练习，不硬塞探索", () => {
    const { repo, state } = makeApp([q("q1")]);
    const learner = repo.createLearner("小测", "elementary_upper");
    repo.upsertReviewCard(learner.id, "question", "q1", new Date().toISOString());
    const plan = planToday({
      repo, index: state.knowledge.index, store: state.questions,
      learnerId: learner.id, budgetMinutes: 6,
    });
    expect(plan.blocks.some((b) => b.kind === "explore")).toBe(false);
  });
});

describe("下一节学什么", () => {
  it("先修没点亮就不冒险往前跳", () => {
    const { repo, state } = makeApp([q("q1")]);
    const learner = repo.createLearner("小测", "elementary_upper");
    const first = nextLesson(repo, state.knowledge.index, state.questions, learner.id);
    // 图谱里排在最前、且没有先修（或先修都点亮）的那个才是新课
    expect(first).not.toBeNull();
    const node = state.knowledge.index.getNode(first!.id)!;
    for (const pre of node.prerequisites ?? []) {
      expect(repo.getMastery(learner.id, pre)?.p ?? 0).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("已经点亮的不再当新课", () => {
    const { repo, state } = makeApp([q("q1")]);
    const learner = repo.createLearner("小测", "elementary_upper");
    const first = nextLesson(repo, state.knowledge.index, state.questions, learner.id)!;
    repo.upsertMastery({
      learnerId: learner.id,
      nodeId: first.id,
      p: 0.95,
      evidenceN: 5,
      lastEvidenceAt: new Date().toISOString(),
    });
    const after = nextLesson(repo, state.knowledge.index, state.questions, learner.id);
    expect(after?.id).not.toBe(first.id);
  });
});
