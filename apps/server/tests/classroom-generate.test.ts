import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { buildLessonFromDraft, parseLooseJson } from "../src/classroom/generate.js";
import { knowledge, makeApp, makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";
import type { Question } from "@mathtutor/schema";

/**
 * 课堂的 generate 模式：模型讲课，但**不出题、不给答案**。
 *
 * 锁住的四件事：
 * - 模型给的好课能用，题目仍来自题库；
 * - 模型给了坏课（坏 JSON、画不出来的图、超长旁白）就退回 compose，孩子照样有课；
 * - 模型写的旁白里出现答案会被剔掉；
 * - 图谱里没有这个知识点时不说"模型失败了"，而是如实说没有。
 */

const node = knowledge.index.getNode(NODE_A)!;

const goodDraft = {
  visualThesis: "用一堆方块看出这个数有几个",
  beats: [
    { role: "intro", narration: "这节课我们看这个数到底有多少。", visual: { id: "v1", primitive: "quantity_bar", params: { count: 12 } } },
    { role: "concept", narration: "一个一个数，数到最后一个就是总数。", visual: { id: "v2", primitive: "number_line", params: { x_range: [0, 20] } } },
    { role: "example", narration: "比如第 3 个，就是排队时站在第三个的那一个。", visual: { id: "v3", primitive: "dot", params: { x: 3, y: 0 } } },
    { role: "summary", narration: "记住：问有几个就数总数，问第几个就找位置。" },
  ],
};

const question: Question = makeQuestion({ id: "q1", nodeIds: [NODE_A], stem: "这里一共有几个？", answer: "12" });

describe("模型草稿 → 可播的课", () => {
  it("好课能过，且题目仍来自题库（模型没机会写答案）", () => {
    const built = buildLessonFromDraft(node, goodDraft, question);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.lesson.scene.visual_objects).toHaveLength(3);
    expect(built.lesson.question?.questionId).toBe("q1");
    // 提问插在小结之前，孩子先想再收尾
    const roles = built.lesson.scene.scenes.map((s) => s.role);
    expect(roles).toContain("check");
    expect(roles.indexOf("check")).toBeLessThan(roles.lastIndexOf("summary"));
  });

  it("旁白里出现答案会被剔掉", () => {
    const draft = structuredClone(goodDraft);
    draft.beats[1]!.narration = "一共有 12 个，所以答案就是 12。";
    const built = buildLessonFromDraft(node, draft, question);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.lesson.narrations.join(" ")).not.toContain("12");
  });

  it("画不出来的图：退回，而不是带着一张假图上课", () => {
    const draft = structuredClone(goodDraft) as Record<string, unknown>;
    (draft.beats as { visual?: unknown }[])[0]!.visual = { id: "v1", primitive: "quantity_bar", params: {} };
    const built = buildLessonFromDraft(node, draft, question);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toContain("count");
  });

  it("不在白名单的图元：退回", () => {
    const draft = structuredClone(goodDraft) as { beats: { visual?: unknown }[] };
    draft.beats[0]!.visual = { id: "v1", primitive: "function_curve", params: { expression: "x**2" } };
    const built = buildLessonFromDraft(node, draft, question);
    expect(built.ok).toBe(false);
  });

  it("拍数太少或旁白太长：退回", () => {
    const tooFew = { visualThesis: "x", beats: [goodDraft.beats[0]!] };
    expect(buildLessonFromDraft(node, tooFew, question).ok).toBe(false);
    const tooLong = structuredClone(goodDraft);
    tooLong.beats[0]!.narration = "很".repeat(200);
    expect(buildLessonFromDraft(node, tooLong, question).ok).toBe(false);
  });
});

describe("模型的 JSON 常常不干净", () => {
  it("围栏包着、前后带话都能捞出来", () => {
    const raw = '好的，这是本节课：\n```json\n{"visualThesis":"t","beats":[]}\n```\n希望有用。';
    expect(parseLooseJson(raw)).toEqual({ visualThesis: "t", beats: [] });
  });

  it("彻底不是 JSON 就返回 null（交给 compose）", () => {
    expect(parseLooseJson("抱歉，我无法完成这个任务。")).toBeNull();
    expect(parseLooseJson("{坏的 json")).toBeNull();
  });
});

describe("接口：generate 失败一定要退回 compose", () => {
  const questions = [makeQuestion({ id: "q1", nodeIds: [NODE_A], stem: "这里一共有几个？", answer: "12" })];

  it("有模型且输出合格：mode=generate", async () => {
    const { app, repo } = makeApp(questions, {
      hintProvider: { generate: async () => JSON.stringify(goodDraft) },
    });
    repo.createLearner("小测", "elementary_upper");
    const res = await app.request(`/api/v1/classroom/lesson?nodeId=${NODE_A}&mode=generate`);
    const body = (await res.json()) as { mode: string; degraded: unknown; scene: { scenes: unknown[] } };
    expect(body.mode).toBe("generate");
    expect(body.degraded).toBeNull();
    expect(body.scene.scenes.length).toBeGreaterThan(3);
  });

  it("模型写了坏 JSON：退回 compose，并说清原因", async () => {
    const { app, repo } = makeApp(questions, {
      hintProvider: { generate: async () => "抱歉，我没法完成。" },
    });
    repo.createLearner("小测", "elementary_upper");
    const res = await app.request(`/api/v1/classroom/lesson?nodeId=${NODE_A}&mode=generate`);
    const body = (await res.json()) as { mode: string; degraded: { reason: string } | null; narrations: string[] };
    expect(res.status).toBe(200);
    expect(body.mode).toBe("compose");
    expect(body.degraded?.reason).toContain("模型");
    expect(body.narrations.length).toBeGreaterThan(0);
  });

  it("模型抛错（端点掉线）：照样有课上", async () => {
    const { app, repo } = makeApp(questions, {
      hintProvider: {
        generate: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    });
    repo.createLearner("小测", "elementary_upper");
    const res = await app.request(`/api/v1/classroom/lesson?nodeId=${NODE_A}&mode=generate`);
    const body = (await res.json()) as { mode: string; degraded: { reason: string } | null };
    expect(res.status).toBe(200);
    expect(body.mode).toBe("compose");
    expect(body.degraded?.reason).toContain("ECONNREFUSED");
  });

  it("没有模型端点：直接 compose，说清是没配模型", async () => {
    const env = tempFixtureEnv(questions);
    const app = createApp(env.state);
    const res = await app.request(`/api/v1/classroom/lesson?nodeId=${NODE_A}&mode=generate`);
    const body = (await res.json()) as { mode: string; degraded: { reason: string } | null };
    expect(body.mode).toBe("compose");
    expect(body.degraded?.reason).toContain("模型");
  });
});
