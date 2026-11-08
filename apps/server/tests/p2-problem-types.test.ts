import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { rankVariantCandidates, skeletonSimilarity, stemSkeleton } from "../src/variantMatch.js";
import { proposeProblemTypes } from "../src/problemTypeProposals.js";
import { createApp, type AppState } from "../src/app.js";
import { AuthStore } from "../src/auth.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";
import { knowledge, makeQuestion, tempFixtureEnv, NODE_A } from "./helpers.js";

/**
 * P2：题型提案与"同题型换题"的确定性判定。
 *
 * 库里 variantOf 全空、problemTypeId 只有 5 道，而这两样是变式门与复习换题的原料。
 * 这里验证两件事：题干骨架能把"换个数"找出来；题型提案的两道闸真的挡住歪挂。
 */

describe("题干骨架", () => {
  it("只差数字的两道题骨架相同", () => {
    const a = stemSkeleton("小明有 26 个苹果，吃掉了 3 个，还剩几个？");
    const b = stemSkeleton("小明有 40 个苹果，吃掉了 8 个，还剩几个？");
    expect(a).toBe(b);
    expect(skeletonSimilarity(a, b)).toBeGreaterThan(0.9);
  });

  it("不同考的题骨架不像", () => {
    const a = stemSkeleton("小明有 26 个苹果，吃掉了 3 个，还剩几个？");
    const b = stemSkeleton("一个长方形的长是 8 厘米，宽是 5 厘米，面积是多少？");
    expect(skeletonSimilarity(a, b)).toBeLessThan(0.3);
  });

  it("排序：换数字 > 同题型 > 措辞相近 > 同节点", () => {
    const original = makeQuestion({ id: "o", nodeIds: [NODE_A], stem: "小明有 26 个苹果，吃掉了 3 个，还剩几个？", answer: "23" });
    const sameSkeleton = makeQuestion({
      id: "a",
      nodeIds: [NODE_A],
      stem: "小明有 40 个苹果，吃掉了 8 个，还剩几个？",
      answer: "32",
    });
    const sameNode = makeQuestion({ id: "b", nodeIds: [NODE_A], stem: "一个长方形长 8 宽 5，面积是多少？", answer: "40" });
    const ranked = rankVariantCandidates(original, [sameNode, sameSkeleton]);
    expect(ranked[0]!.question.id).toBe("a");
    expect(ranked[0]!.quality).toBe("same-skeleton");
    expect(ranked[1]!.quality).toBe("same-node");
  });

  it("不可用的题（最近做对过、答案未核验）会被 eligible 挡掉", () => {
    const original = makeQuestion({ id: "o", nodeIds: [NODE_A], stem: "甲有 5 个，乙有 3 个，一共几个？", answer: "8" });
    const twin = makeQuestion({ id: "t", nodeIds: [NODE_A], stem: "甲有 7 个，乙有 2 个，一共几个？", answer: "9" });
    const ranked = rankVariantCandidates(original, [twin], () => false);
    expect(ranked).toHaveLength(0);
  });
});

describe("题型提案", () => {
  /** 真实题库里找一道有题型声明的题，用它的节点做 fixture */
  const type = knowledge.problemTypes.find((t) => t.nodes.length > 0 && t.keywords?.length)!;

  it("本学段对不上就不提案（小学的题不可能是高中题型）", () => {
    const q = makeQuestion({
      id: "q1",
      nodeIds: [type.nodes[0]!],
      stem: `关于${type.name}的题`,
      level: "elementary_lower",
    });
    const proposals = proposeProblemTypes({ questions: [q], problemTypes: knowledge.problemTypes });
    expect(proposals.every((p) => p.proposed !== type.id || type.stage === "primary")).toBe(true);
  });

  it("知识点对不上就不提案（结构性的闸，撞不了运气）", () => {
    const q = makeQuestion({ id: "q2", nodeIds: [NODE_A], stem: `关于${type.name}的题` });
    const proposals = proposeProblemTypes({ questions: [q], problemTypes: knowledge.problemTypes });
    expect(proposals.some((p) => p.proposed === type.id)).toBe(false);
  });

  it("已经挂过题型的不再提案", () => {
    const q = makeQuestion({ id: "q3", nodeIds: [type.nodes[0]!], stem: `关于${type.name}的题`, problemTypeId: type.id });
    expect(proposeProblemTypes({ questions: [q], problemTypes: knowledge.problemTypes })).toHaveLength(0);
  });
});

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

describe("题型提案接口", () => {
  const type = knowledge.problemTypes.find((t) => t.nodes.length > 0 && t.keywords?.length)!;

  function makeEnv() {
    const q = makeQuestion({
      id: "pt1",
      nodeIds: [type.nodes[0]!],
      stem: `关于${type.name}的题：${type.keywords!.join("，")}`,
      level: "elementary_upper",
    });
    const env = tempFixtureEnv([q]);
    const db = openMemoryDb();
    const state: AppState = { ...env.state, repo: new Repo(db), auth: new AuthStore(db), authDisabled: false };
    return { ...env, state, app: createApp(state) };
  }

  it("孩子打不开；家长能看到提案并采纳，落盘后可读回", async () => {
    const env = makeEnv();
    const parent = client(env.app);
    await parent.call("POST", "/api/v1/auth/setup-parent", { username: "爸爸", password: "family-secret" });
    const child = client(env.app);
    await child.call("POST", "/api/v1/auth/register-child", {
      username: "小明",
      password: "child-secret",
      level: "elementary_upper",
    });

    expect((await child.call("GET", "/api/v1/bank/problem-type-proposals")).status).toBe(403);

    const list = await parent.call("GET", "/api/v1/bank/problem-type-proposals?include=all");
    expect(list.status).toBe(200);
    expect(list.body.proposals.length).toBeGreaterThan(0);
    const first = list.body.proposals[0];

    const applied = await parent.call("POST", "/api/v1/bank/problem-type-proposals/apply", { ids: [first.questionId] });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(1);

    // 文件是第一现场：写进去了，而且能读回来
    const dir = path.join(env.dataDir, "knowledge", "questions");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const onDisk = files.flatMap((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { id: string; problemTypeId?: string }[]);
    expect(onDisk.find((q) => q.id === first.questionId)?.problemTypeId).toBe(first.proposed);
    expect(env.state.questions.byId.get(first.questionId)?.problemTypeId).toBe(first.proposed);

    // 采纳过的不再出现
    const again = await parent.call("GET", "/api/v1/bank/problem-type-proposals?include=all");
    expect(again.body.proposals.some((p: { questionId: string }) => p.questionId === first.questionId)).toBe(false);
  });
});
