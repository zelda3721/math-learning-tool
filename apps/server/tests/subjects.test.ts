import { describe, expect, it } from "vitest";
import { SubjectRegistry } from "@mathtutor/core";
import { englishSubject } from "@mathtutor/subject-english";
import { knowledge, makeQuestion } from "./helpers.js";
import { createSubjectRegistry, itemTypeOf, judgeAnswer, subjectOf } from "../src/subjects.js";

/**
 * 阶段 1 的收口：判卷走注册表。
 *
 * 这些用例锁的是"内核不认识数学"这件事——它只知道"题目属于哪个学科、题型是什么、
 * 该学科有没有登记判卷器"。数学之所以能判，是因为它有判卷器，不是因为它叫数学。
 */

const registry = createSubjectRegistry();

describe("题目 → 学科 → 判卷器", () => {
  it("数学题：按节点归属解析出学科与题型", () => {
    const q = makeQuestion({ id: "q1", answer: "26" });
    expect(subjectOf(q, knowledge)).toBe("math");
    expect(itemTypeOf("math", q)).toBe(`math.${q.answerType}`);
  });

  it("数学题走数学判卷器，verification 是 executable", async () => {
    const q = makeQuestion({ id: "q2", answer: "26" });
    const r = await judgeAnswer(registry, knowledge, q, " 26 ");
    expect(r).toMatchObject({ correct: true, hasJudge: true, verification: "executable" });
  });

  it("判不准时仍然是 pending，交家长（而不是「没有判卷器」那条路）", async () => {
    // 过程题的参考答案是老师的话，孩子用自己的话答——规则判不了，只能转家长
    const q = makeQuestion({ id: "q3", answer: "先算周长公式", answerType: "steps" });
    const r = await judgeAnswer(registry, knowledge, q, "我先把长和宽加起来再乘二");
    expect(r.method).toBe("pending");
    expect(r.hasJudge).toBe(true);
  });

  it("学科没登记判卷器 → 不判，转家长，且不留下 executable 的证据", async () => {
    const onlyEnglish = new SubjectRegistry();
    onlyEnglish.register(englishSubject);
    const q = makeQuestion({ id: "q4", answer: "26" });

    const r = await judgeAnswer(onlyEnglish, knowledge, q, "26");
    expect(r).toMatchObject({ correct: false, method: "pending", hasJudge: false });
    // 连 AI 判断都没有的题，不能写成可执行验证
    expect(r.verification).toBe("ai_unverified");
  });

  it("nodeIds 为空的临时题沿用历史上按数学判的行为（不因接入内核而坏掉）", async () => {
    const q = makeQuestion({ id: "q5", answer: "26", nodeIds: [] });
    expect(subjectOf(q, knowledge)).toBe("math");
    const r = await judgeAnswer(registry, knowledge, q, "26");
    expect(r.correct).toBe(true);
  });
});
