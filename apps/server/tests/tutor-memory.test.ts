import { describe, expect, it } from "vitest";
import { makeApp, NODE_A } from "./helpers.js";
import { deriveMemories, profileBlock, readProfile, recallBlock, writeProfile } from "../src/tutorMemory.js";

/**
 * 导师长期记忆：可解释、可删、只在本地。
 *
 * 最重要的是最后一条——**删了就真的不再被召回**。做不到这一点的"记忆"，
 * 家长会认为它在骗他。
 */

function learner(repo: ReturnType<typeof makeApp>["repo"], level = "elementary_upper") {
    return repo.createLearner("小测", level as never).id;
}

describe("记忆的读与写", () => {
    it("同一件事重复发生只留一条，计数累加", () => {
        const { repo } = makeApp([]);
        const id = learner(repo);
        const input = { learnerId: id, kind: "struggle", text: "在「分数」上错过 2 次", dedupeKey: "struggle:fraction", source: "derived" };
        repo.rememberMemory(input);
        repo.rememberMemory(input);
        const memories = repo.listMemories(id);
        expect(memories).toHaveLength(1);
        expect(memories[0]!.hitCount).toBe(2);
    });

    it("各孩子各记各的（隔离）", () => {
        const { repo } = makeApp([]);
        const a = learner(repo);
        const b = learner(repo);
        repo.rememberMemory({ learnerId: a, kind: "goal", text: "想学会通分", dedupeKey: "goal:1", source: "profile" });
        expect(repo.listMemories(a)).toHaveLength(1);
        expect(repo.listMemories(b)).toHaveLength(0);
    });

    it("删掉之后不再被召回，但家长仍能看见「删过」", () => {
        const { repo } = makeApp([]);
        const id = learner(repo);
        repo.rememberMemory({ learnerId: id, kind: "struggle", text: "在「分数」上错过 2 次", dedupeKey: "struggle:fraction", source: "derived" });
        const [memory] = repo.listMemories(id);

        expect(repo.forgetMemory(id, memory!.id)).toBe(true);
        expect(repo.listMemories(id)).toHaveLength(0);
        expect(recallBlock(repo, id)).toBe("");

        const withDeleted = repo.listMemories(id, { includeDeleted: true });
        expect(withDeleted).toHaveLength(1);
        expect(withDeleted[0]!.deletedAt).toBeTruthy();
    });

    it("同一条删两次：第二次返回 false，接口据此回 404", () => {        const { repo } = makeApp([]);
        const id = learner(repo);
        repo.rememberMemory({ learnerId: id, kind: "goal", text: "想学会通分", dedupeKey: "g", source: "profile" });
        const [memory] = repo.listMemories(id);
        expect(repo.forgetMemory(id, memory!.id)).toBe(true);
        expect(repo.forgetMemory(id, memory!.id)).toBe(false);
    });
    it("删掉的记忆不会被下一轮派生复活（墓碑挡住重写）", () => {
        const { repo, state } = makeApp([]);
        const id = learner(repo);
        for (let i = 0; i < 2; i++) {
            repo.insertMistake({
                id: `m${i}`,
                attemptId: `a${i}`,
                learnerId: id,
                questionId: `q${i}`,
                surface: "concept",
                rootNodeId: NODE_A,
                misconceptionId: undefined,
                chain: [],
                confidence: 0.8,
                eligible: true,
            });
        }
        deriveMemories(repo, state.knowledge.index, id);
        const [memory] = repo.listMemories(id);
        expect(repo.forgetMemory(id, memory!.id)).toBe(true);

        // 下一轮对话前照常重新派生：同一批事实还在，但这条记忆不该回来
        deriveMemories(repo, state.knowledge.index, id);
        deriveMemories(repo, state.knowledge.index, id);

        expect(repo.listMemories(id)).toHaveLength(0);
        expect(recallBlock(repo, id)).toBe("");
        // 审计上仍保留"曾有一条、何时被删"
        expect(repo.listMemories(id, { includeDeleted: true })[0]!.deletedAt).toBeTruthy();
    });
});

describe("从事实派生记忆", () => {
    it("同一个根因错两次以上才记「卡住」，一次不算", () => {
        const { repo, state } = makeApp([]);
        const id = learner(repo);
        for (let i = 0; i < 2; i++) {
            repo.insertMistake({
                id: `m${i}`,
                attemptId: `a${i}`,
                learnerId: id,
                questionId: `q${i}`,
                surface: "concept",
                rootNodeId: NODE_A,
                misconceptionId: undefined,
                chain: [],
                confidence: 0.8,
                eligible: true,
            });
        }
        deriveMemories(repo, state.knowledge.index, id);
        const memories = repo.listMemories(id);
        expect(memories).toHaveLength(1);
        expect(memories[0]!.kind).toBe("struggle");
        expect(memories[0]!.text).toContain("2 次");
        // 派生出来的记忆能被召回（拼进系统提示的那一段）
        expect(recallBlock(repo, id)).toContain("2 次");
    });

    it("重复派生不会堆出重复条目", () => {
        const { repo, state } = makeApp([]);
        const id = learner(repo);
        repo.insertMistake({
            id: "m1",
            attemptId: "a1",
            learnerId: id,
            questionId: "q1",
            surface: "concept",
            rootNodeId: NODE_A,
            misconceptionId: undefined,
            chain: [],
            confidence: 0.8,
            eligible: true,
        });
        repo.insertMistake({
            id: "m2",
            attemptId: "a2",
            learnerId: id,
            questionId: "q2",
            surface: "concept",
            rootNodeId: NODE_A,
            misconceptionId: undefined,
            chain: [],
            confidence: 0.8,
            eligible: true,
        });

        deriveMemories(repo, state.knowledge.index, id);
        deriveMemories(repo, state.knowledge.index, id);
        expect(repo.listMemories(id)).toHaveLength(1);
    });
});

describe("画像", () => {
    it("兴趣与目标写进去能读回来，画像块拼得出来", () => {
        const { repo } = makeApp([]);
        const id = learner(repo);
        const profile = writeProfile(repo, id, { interests: ["足球", "恐龙"], goals: ["学会通分"], prefersVisual: true });
        expect(profile.interests).toEqual(["足球", "恐龙"]);
        expect(readProfile(repo, id).goals).toEqual(["学会通分"]);

        const block = profileBlock(profile);
        expect(block).toContain("足球");
        expect(block).toContain("先画再算");
    });

    it("什么都没填时不给导师塞空话", () => {
        const { repo } = makeApp([]);
        const id = learner(repo);
        expect(profileBlock(readProfile(repo, id))).toBe("");
    });
});

describe("接口", () => {
    it("列出记忆、删掉一条、再列就没有了", async () => {
        const { app, repo } = makeApp([]);
        const id = learner(repo);
        repo.rememberMemory({ learnerId: id, kind: "goal", text: "想学会通分", dedupeKey: "g", source: "profile" });

        const list = (await (await app.request(`/api/v1/parent/memories?learnerId=${id}`)).json()) as {
            memories: { id: string }[];
        };
        expect(list.memories).toHaveLength(1);

        const del = await app.request(`/api/v1/parent/memories/${list.memories[0]!.id}?learnerId=${id}`, { method: "DELETE" });
        expect(del.status).toBe(200);

        const after = (await (await app.request(`/api/v1/parent/memories?learnerId=${id}`)).json()) as { memories: unknown[] };
        expect(after.memories).toHaveLength(0);

        const again = await app.request(`/api/v1/parent/memories/${list.memories[0]!.id}?learnerId=${id}`, { method: "DELETE" });
        expect(again.status).toBe(404);
    });

    it("画像接口能读能写", async () => {
        const { app, repo } = makeApp([]);
        const id = learner(repo);
        const post = await app.request("/api/v1/parent/profile", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ learnerId: id, interests: ["篮球"], prefersVisual: false }),
        });
        expect(post.status).toBe(200);
        const get = (await (await app.request(`/api/v1/parent/profile?learnerId=${id}`)).json()) as {
            interests: string[];
            prefersVisual: boolean | null;
        };
        expect(get.interests).toEqual(["篮球"]);
        expect(get.prefersVisual).toBe(false);
    });
});
