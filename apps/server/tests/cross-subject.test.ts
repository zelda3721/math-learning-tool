import { describe, expect, it } from "vitest";
import { auditLinks, crossSubjectMembers } from "@mathtutor/knowledge";
import { makeApp } from "./helpers.js";

/**
 * 跨学科：一个知识点在别的学科里怎么用。
 *
 * 这一层最怕的不是写错字，是慢慢长出一堆"两科有关系"的废话。
 * 所以两条底线都有测试：说明必须具体（lint 里查 note 长度），
 * 而且只显示两边节点都存在的连接（点不开的链接比没有更糟）。
 */

describe("真实连接表", () => {
    it("每条连接的两端都在图里，且都是真的跨学科", () => {
        const { state } = makeApp([]);
        const { problems, crossSubjectCount } = auditLinks(state.knowledge.index, state.knowledge.links);
        expect(problems).toEqual([]);
        // 现有连接全是数学 ↔ 英语，没有同学科凑数的
        expect(crossSubjectCount).toBe(state.knowledge.links.length);
        expect(crossSubjectCount).toBeGreaterThanOrEqual(10);
    });

    it("数学节点能查到英语那边的用法，英语节点反过来也能查到数学", () => {
        const { state } = makeApp([]);
        const fromMath = crossSubjectMembers(state.knowledge.index, state.knowledge.links, "decimal");
        expect(fromMath.length).toBeGreaterThan(0);
        expect(fromMath[0]!.subject).toBe("english");
        expect(fromMath[0]!.note).toContain("美分");

        const fromEnglish = crossSubjectMembers(state.knowledge.index, state.knowledge.links, "en:money-words");
        expect(fromEnglish.some((m) => m.nodeId === "decimal")).toBe(true);
    });
});

describe("接口", () => {
    it("按节点取跨学科用法，带上学科中文名", async () => {
        const { app } = makeApp([]);
        const res = await app.request("/api/v1/atlas/cross-subject?nodeId=fraction");
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            members: { nodeId: string; subjectLabel: string; note: string }[];
        };
        expect(body.members.length).toBeGreaterThan(0);
        expect(body.members[0]!.subjectLabel).toBe("英语");
        expect(body.members[0]!.note.length).toBeGreaterThan(8);
    });

    it("没有跨学科连接的节点返回空数组，而不是 404", async () => {
        const { app } = makeApp([]);
        const res = await app.request("/api/v1/atlas/cross-subject?nodeId=derivative");
        expect(res.status).toBe(200);
        expect(((await res.json()) as { members: unknown[] }).members).toEqual([]);
    });

    it("节点不存在 → 404；缺参数 → 400", async () => {
        const { app } = makeApp([]);
        expect((await app.request("/api/v1/atlas/cross-subject?nodeId=nope")).status).toBe(404);
        expect((await app.request("/api/v1/atlas/cross-subject")).status).toBe(400);
    });

    it("星图数据里已经含英语节点（同一张图，不是两套索引）", async () => {
        const { app } = makeApp([]);
        const body = (await (await app.request("/api/v1/atlas")).json()) as {
            graph: { nodes: { id: string; subject: string }[] };
        };
        const english = body.graph.nodes.filter((n) => n.subject === "english");
        expect(english.length).toBeGreaterThan(10);
        expect(english.every((n) => n.id.startsWith("en:"))).toBe(true);
    });
});
