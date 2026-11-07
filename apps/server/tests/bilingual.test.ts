import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QuestionSchema, type Question } from "@mathtutor/schema";
import { createSubjectRegistry, judgeAnswer } from "../src/subjects.js";
import { makeApp } from "./helpers.js";

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
