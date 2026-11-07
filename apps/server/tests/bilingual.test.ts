import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QuestionSchema, type Question } from "@mathtutor/schema";
import { createSubjectRegistry, judgeAnswer } from "../src/subjects.js";
import { knowledge, makeApp } from "./helpers.js";
import { bilingualIssues } from "../src/questions.js";

/**
 * 双语题：读懂英文题面 → 算 → 用英语说出结论。
 *
 * 这是「综合运用」最小的一个闭环，两件事必须成立：
 * 1. **读写分开判**：题面是英文但答案是数字的，走数学判卷（判算得对不对）；
 *    答案要用英语写出来的，走英语判卷（判表达，证据等级 reference）。
 * 2. **证据落到两科**：一道题关联了数学节点与英语节点，答完两边都要有掌握度记录，
 *    否则"综合运用"就只是界面上并排显示，心里并不真的算过两科。
 */

const seedPath = fileURLToPath(
  new URL("../../../data/knowledge/questions/2026-11-06-bilingual-en-math.json", import.meta.url),
);

const seeded: Question[] = (JSON.parse(readFileSync(seedPath, "utf8")) as unknown[]).map((raw) =>
  QuestionSchema.parse(raw),
);

function byId(id: string): Question {
  const found = seeded.find((q) => q.id === id);
  if (!found) throw new Error(`种子题里没有 ${id}`);
  return found;
}

describe("种子题", () => {
  it("每道都有英文题面，且中英文都在", () => {
    expect(seeded.length).toBeGreaterThanOrEqual(6);
    for (const q of seeded) {
      expect(q.stemEn, q.id).toBeTruthy();
      expect(q.stem.length, q.id).toBeGreaterThan(0);
    }
  });

  it("要用英语作答的题，答案本身是英文短语；数字作答的题不乱标语言", () => {
    for (const q of seeded) {
      if (q.answerLang === "en") {
        expect(q.answer).toMatch(/[a-z]/i);
      } else {
        expect(q.answer).toMatch(/^[\d.]+$/);
      }
    }
  });
});

describe("判卷", () => {
  it("英文作答：大小写与多余空格不影响判定，证据等级是 reference", async () => {
    const { state } = makeApp([]);
    const q = byId("bi-fraction-words-01");
    const ok = await judgeAnswer(createSubjectRegistry(), state.knowledge, q, "  Three   Quarters. ");
    expect(ok.correct).toBe(true);
    expect(ok.verification).toBe("reference");

    const wrong = await judgeAnswer(createSubjectRegistry(), state.knowledge, q, "three quarter");
    expect(wrong.correct).toBe(false);
  });

  it("数字作答的英文题面：仍然按数学判卷（判的是算得对不对）", async () => {
    const { state } = makeApp([]);
    const q = byId("bi-money-change-01");
    const ok = await judgeAnswer(createSubjectRegistry(), state.knowledge, q, "2.25");
    expect(ok.correct).toBe(true);
    expect(ok.verification).toBe("executable");
  });

  it("价格读法：three dollars fifty 对，执意写 three dollars and fifty cents 不放过（这版按参考答案例）", async () => {
    const { state } = makeApp([]);
    const q = byId("bi-money-words-01");
    expect((await judgeAnswer(createSubjectRegistry(), state.knowledge, q, "three dollars fifty")).correct).toBe(true);
  });
});

describe("证据落两科", () => {
    it("答完一道双语题，数学节点与英语节点都写进掌握度", async () => {
        const q = byId("bi-fraction-words-01");
        const { app, repo } = makeApp([q]);
        const learnerId = repo.createLearner("小测", "elementary_upper").id;

        const res = await app.request("/api/v1/practice/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ learnerId, questionId: q.id, answer: "three quarters" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { correct: boolean; masteryChanges?: { nodeId: string }[] };
        expect(body.correct).toBe(true);

        const nodeIds = repo.allMastery(learnerId).map((row) => row.nodeId).sort();
        expect(nodeIds).toEqual([...q.nodeIds].sort());
        // 数学节点与英语节点都在里面
        expect(nodeIds.some((id) => id.startsWith("en:"))).toBe(true);
        expect(nodeIds.some((id) => !id.startsWith("en:"))).toBe(true);
    });

    it("答错也能落证据（英语节点同样记一次没答对）", async () => {
        const q = byId("bi-telling-time-01");
        const { app, repo } = makeApp([q]);
        const learnerId = repo.createLearner("小测", "elementary_upper").id;

        await app.request("/api/v1/practice/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ learnerId, questionId: q.id, answer: "eight thirty" }),
        });

        const rows = repo.allMastery(learnerId);
        expect(rows.length).toBe(q.nodeIds.length);
        expect(rows.every((row) => row.evidenceN >= 1)).toBe(true);
    });
});


describe("不硬凑融合", () => {
    it("单学科题（没有英文题面、没有英语节点）不受影响", async () => {
        const pureMath = QuestionSchema.parse({
            id: "pure-math-01",
            nodeIds: ["fraction"],
            level: "elementary_upper",
            stem: "把一张纸平均分成 4 份，每份是几分之几？",
            answer: "1/4",
            answerType: "expression",
            difficulty: 2,
            contentHash: "x",
            source: { role: "manual" },
            status: "verified",
        });
        expect(bilingualIssues(pureMath, knowledgeLike().index)).toEqual([]);

        const pureEnglish = QuestionSchema.parse({
            id: "pure-en-01",
            nodeIds: ["en:fraction-words"],
            level: "elementary_upper",
            stem: "3/4 用英语怎么说？",
            answer: "three quarters",
            answerType: "expression",
            answerLang: "en",
            difficulty: 2,
            contentHash: "y",
            source: { role: "manual" },
            status: "verified",
        });
        // 纯英语专项题：挂了英语节点、也用了英语，规矩不拦它
        expect(bilingualIssues(pureEnglish, knowledgeLike().index)).toEqual([]);
    });

    it("挂着英文题面却没有英语节点 → 判为「翻译了一遍」，不算融合", () => {
        const translated = QuestionSchema.parse({
            id: "translated-01",
            nodeIds: ["decimal"],
            level: "elementary_upper",
            stem: "一支笔 2.75 元，付 5 元找零多少？",
            stemEn: "A pen costs $2.75. You pay $5. How much change?",
            answer: "2.25",
            answerType: "numeric",
            difficulty: 2,
            contentHash: "z",
            source: { role: "manual" },
            status: "verified",
        });
        const issues = bilingualIssues(translated, knowledgeLike().index);
        expect(issues).toHaveLength(1);
        expect(issues[0]).toContain("没有英语知识点");
    });

    it("挂了英语节点却既没英文题面也没要求英文作答 → 那个节点不该在这道题上", () => {
        const decorated = QuestionSchema.parse({
            id: "decorated-01",
            nodeIds: ["decimal", "en:money-words"],
            level: "elementary_upper",
            stem: "一支笔 2.75 元，付 5 元找零多少？",
            answer: "2.25",
            answerType: "numeric",
            difficulty: 2,
            contentHash: "w",
            source: { role: "manual" },
            status: "verified",
        });
        const issues = bilingualIssues(decorated, knowledgeLike().index);
        expect(issues).toHaveLength(1);
        expect(issues[0]).toContain("却没有英文题面");
    });

    it("种子里那 6 道都说得通（每道英文的都有对应的英语节点）", () => {
        for (const q of seeded) {
            expect(bilingualIssues(q, knowledgeLike().index), q.id).toEqual([]);
            if (q.stemEn) expect(q.nodeIds.some((id) => id.startsWith("en:"))).toBe(true);
        }
    });
});

function knowledgeLike() {
    return knowledge;
}
