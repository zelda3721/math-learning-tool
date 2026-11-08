import { describe, expect, it } from "vitest";
import path from "node:path";
import { composeToday, prerequisiteDepth } from "../src/composer.js";
import { createQuestionStore } from "../src/questions.js";
import { knowledge, makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

/**
 * P2：让新孩子从对的地方开始。
 *
 * 三件事都是实机上出过问题的：
 * ① 新孩子第一组是 6 道同一节点的同类题（不知道他会不会，却压在最小的知识点上）；
 * ② 数学练习里混进纯英语题（各主线自己的 order 被当成全局顺序）；
 * ③ 原图丢了的"如图"题照样发给孩做（读不懂题，页面也不报错）。
 */

describe("先修深度", () => {
  it("没有前置是 0，有前置的比前置深", () => {
    const depth = prerequisiteDepth(knowledge.index);
    for (const node of knowledge.graph.nodes) {
      const mine = depth.get(node.id) ?? 0;
      for (const pre of node.prerequisites ?? []) {
        expect(mine).toBeGreaterThan(depth.get(pre) ?? 0);
      }
    }
  });
});

describe("新孩子摸底", () => {
  it("第一组按知识点铺开，不是同一道题的同类堆在一起", () => {
    const nodes = knowledge.graph.nodes.filter(
      (n) => (n.subject ?? "math") === "math" && n.stage === "primary",
    );
    const picked = nodes.slice(0, 4);
    const questions = picked.flatMap((n, i) =>
      [0, 1].map((k) =>
        makeQuestion({ id: `p${i}-${k}`, nodeIds: [n.id], stem: `摸底题 ${i}-${k}`, answer: String(20 + i * 2 + k) }),
      ),
    );
    const { store, repo } = tempFixtureEnv(questions);
    const learner = repo.createLearner("新来的", "elementary_upper");

    const composed = composeToday(store, knowledge.index, repo, learner.id, { count: 6 });
    expect(composed.length).toBeGreaterThan(0);
    expect(composed.every((c) => c.slot === "placement")).toBe(true);
    const distinctNodes = new Set(composed.flatMap((c) => c.question.nodeIds));
    expect(distinctNodes.size).toBeGreaterThan(1);
  });
});

describe("数学练习里不出英语题", () => {
  it("只有英语知识点的题不会被选进数学组卷", () => {
    const englishNode = knowledge.graph.nodes.find((n) => (n.subject ?? "math") !== "math");
    expect(englishNode).toBeTruthy();
    const questions = [
      makeQuestion({ id: "math1", nodeIds: [NODE_A], stem: "数学题", answer: "3" }),
      makeQuestion({
        id: "english1",
        nodeIds: [englishNode!.id],
        stem: "Fill in: I ___ a student.",
        answer: "am",
        stemEn: "Fill in: I ___ a student.",
        answerLang: "en",
      }),
    ];
    const { store, repo } = tempFixtureEnv(questions);
    const learner = repo.createLearner("双语娃", "elementary_upper");
    const ids = composeToday(store, knowledge.index, repo, learner.id, { count: 6 }).map((c) => c.question.id);
    expect(ids).toContain("math1");
    expect(ids).not.toContain("english1");
  });
});

describe("原图丢了的题不进组卷", () => {
  it("配图文件不存在 → 这道题被排除，但题还在题库里", () => {
    const questions = [
      makeQuestion({ id: "withFigure", nodeIds: [NODE_A], stem: "如图，求阴影面积", answer: "12", figureImage: "missing.png" }),
      makeQuestion({ id: "plain", nodeIds: [NODE_A], stem: "普通题", answer: "7" }),
    ];
    const env = tempFixtureEnv(questions);
    const figuresDir = path.join(env.dataDir, "figures-empty");
    const store = createQuestionStore(env.dataDir, knowledge.index, figuresDir);
    expect(store.figureMissing.has("withFigure")).toBe(true);
    expect(store.byId.has("withFigure")).toBe(true);

    const learner = env.repo.createLearner("小明", "elementary_upper");
    const ids = composeToday(store, knowledge.index, env.repo, learner.id, { count: 6 }).map((c) => c.question.id);
    expect(ids).not.toContain("withFigure");
    expect(ids).toContain("plain");
  });
});
