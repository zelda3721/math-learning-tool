import { describe, expect, it } from "vitest";
import { availableLessons, composeLesson, pickLessonQuestion } from "../src/classroom/lesson.js";
import { makeApp, makeQuestion, NODE_A } from "./helpers.js";

/**
 * 组课（compose 模式）：知识点档案 + 题库 → 一节离线能讲完的课。
 *
 * 验的三件事都是"错了孩子会直接受害"的：
 * 1. 旁白必须来自档案（不编）；
 * 2. 提问的上下文里不能有答案（数字整词剔除）；
 * 3. 对外的课里没有 answer / analysis / salt / contentHash。
 */

const QUESTIONS = [
  makeQuestion({ id: "q-easy", stem: "小明有 25 个苹果，又买来 17 个，现在有多少个？", answer: "42", difficulty: 2 }),
  makeQuestion({ id: "q-hard", stem: "计算 3 × 7 + 4", answer: "25", difficulty: 5 }),
];

describe("composeLesson", () => {
    it("旁白来自知识点档案，不是模型编的", () => {
        const { state } = makeApp(QUESTIONS);
        const node = state.knowledge.index.getNode(NODE_A)!;
        const lesson = composeLesson(NODE_A, state.knowledge.index, state.questions)!;

        expect(lesson.nodeName).toBe(node.name);
        // 第一拍一定带名字，且至少有一拍能与档案里的原文对上
        expect(lesson.narrations[0]).toContain(node.name);
        const archiveText = [node.summary, node.whatIsIt, node.bigPicture, node.applications?.[0]?.detail]
            .filter(Boolean)
            .join("");
        expect(lesson.narrations.some((line) => archiveText.includes(line.replace(/…$/, "").slice(0, 12)))).toBe(true);
    });

    it("提问插在讲解之后、小结之前，答完回到的仍是那一拍", () => {
        const { state } = makeApp(QUESTIONS);
        const lesson = composeLesson(NODE_A, state.knowledge.index, state.questions)!;

        expect(lesson.question).not.toBeNull();
        expect(lesson.pauseBeatIndex).toBeGreaterThan(0);
        expect(lesson.pauseBeatIndex).toBeLessThan(lesson.scene.scenes.length - 1);
        expect((lesson.scene.scenes[lesson.pauseBeatIndex] as { role: string }).role).toBe("check");
        // 一拍一个 scene beat，旁白与画面一一对应
        expect(lesson.scene.scenes).toHaveLength(lesson.narrations.length);
    });

    it("课堂提问挑的是难度最低的那道：检查理解，不是闯关", () => {
        const { state } = makeApp(QUESTIONS);
        expect(pickLessonQuestion(state.questions, NODE_A)?.id).toBe("q-easy");
    });

    it("知识点上没题也能开课，只是不提问", () => {
        const { state } = makeApp([]);
        const lesson = composeLesson(NODE_A, state.knowledge.index, state.questions)!;
        expect(lesson.question).toBeNull();
        expect(lesson.pauseBeatIndex).toBe(-1);
        expect(lesson.narrations.length).toBeGreaterThan(0);
    });

    it("图谱里没有这个节点 → null，而不是一节课空的课", () => {
        const { state } = makeApp(QUESTIONS);
        expect(composeLesson("no-such-node", state.knowledge.index, state.questions)).toBeNull();
    });

    it("档案里没写 whatIsIt 时，用演变/用途补一拍（总比只有一句标题强）", () => {
        const { state } = makeApp(QUESTIONS);
        // 真实图谱里每个节点都有 whatIsIt，所以这条回退路径只能用一个最小假 index 触发
        const bareNode = {
            ...state.knowledge.index.getNode(NODE_A)!,
            whatIsIt: undefined,
            evolvesTo: [{ to: "add-sub-20", how: "会数数之后把两堆合起来，就是加法。" }],
            applications: [],
        };
        const fakeIndex = { getNode: (id: string) => (id === bareNode.id ? bareNode : undefined) } as never;

        const lesson = composeLesson(bareNode.id, fakeIndex, state.questions)!;
        expect(lesson.narrations.some((line) => line.includes("两堆合起来"))).toBe(true);
    });

    it("旁白里不含这道题的答案（数字整词剔除）", () => {
        const { state } = makeApp(QUESTIONS);
        const lesson = composeLesson(NODE_A, state.knowledge.index, state.questions)!;
        const answer = lesson.question ? QUESTIONS.find((q) => q.id === lesson.question!.questionId)!.answer : null;
        if (answer) {
            for (const line of lesson.narrations) {
                expect(line.includes(answer)).toBe(false);
            }
        }
    });
});

describe("availableLessons", () => {
    it("只列有可发题目的知识点，低学段在前", () => {
        const { state } = makeApp(QUESTIONS);
        const lessons = availableLessons(state.knowledge.index, state.questions);
        expect(lessons.length).toBeGreaterThan(0);
        const stages = lessons.map((l) => l.stage);
        const order = ["elementary_lower", "elementary_upper", "middle", "high", "advanced"];
        const indexes = stages.map((s) => order.indexOf(s)).filter((i) => i >= 0);
        expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
        expect(lessons.every((l) => l.questionCount > 0)).toBe(true);
    });
});

describe("课堂接口", () => {
    it("列出可开的课", async () => {
        const { app } = makeApp(QUESTIONS);
        const res = await app.request("/api/v1/classroom/lessons");
        expect(res.status).toBe(200);
        const body = (await res.json()) as { lessons: { nodeId: string }[] };
        expect(body.lessons.length).toBeGreaterThan(0);
    });

    it("给出一节课，且对外 JSON 里没有任何判卷依据", async () => {
        const { app } = makeApp(QUESTIONS);
        const res = await app.request(`/api/v1/classroom/lesson?nodeId=${encodeURIComponent(NODE_A)}`);
        expect(res.status).toBe(200);
        const raw = await res.text();
        const body = JSON.parse(raw) as {
            narrations: string[];
            question: { questionId: string } | null;
            pauseContext: string;
            scene: { scenes: unknown[] };
        };

        expect(body.narrations.length).toBeGreaterThan(0);
        expect(body.question).not.toBeNull();
        // 孩子手里的数据不该含判卷依据：这四个词一个都不许出现
        for (const forbidden of ["analysis", "contentHash", "salt", "correctAnswer"]) {
            expect(raw.includes(forbidden)).toBe(false);
        }
        // 正确答案的数值也不能出现在下发内容里
        expect(raw.includes('"42"')).toBe(false);
    });

    it("知识点不存在 → 404，缺参数 → 400", async () => {
        const { app } = makeApp(QUESTIONS);
        expect((await app.request("/api/v1/classroom/lesson?nodeId=nope")).status).toBe(404);
        expect((await app.request("/api/v1/classroom/lesson")).status).toBe(400);
    });
});
