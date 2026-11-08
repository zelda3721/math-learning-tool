import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeApp } from "./helpers.js";
import { judgeVocab, loadVocabulary, recordVocabAnswer, vocabBatch, NEW_WORDS_PER_DAY } from "../src/vocabulary.js";
import { judgeReading, loadReading } from "../src/reading.js";

/**
 * 英语两条线：词汇与分级阅读。
 *
 * 共同的要求只有一句：**答案要有出处**。词汇的出处是词表，阅读的出处是原文那一句。
 * 这里锁住的都是"看起来像学会了、其实没有"的形态：把错词判对、把没有出处的题发给孩子、
 * 第一次答对就当成长期记住。
 */

const WORDS = [
  { id: "w-apple", zh: "苹果", en: "apple", cefr: "A1", example: "I ate an apple after lunch." },
  { id: "w-borrow", zh: "借（进来）", en: "borrow", cefr: "A2", example: "May I borrow your ruler?" },
  { id: "w-icecream", zh: "冰淇淋", en: "ice cream", cefr: "A1", example: "We had ice cream in the park." },
];

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mathtutor-en-"));
  mkdirSync(path.join(dir, "reading"), { recursive: true });
  writeFileSync(path.join(dir, "vocabulary.json"), JSON.stringify(WORDS), "utf8");
  process.env.ENGLISH_VOCAB_PATH = path.join(dir, "vocabulary.json");
  process.env.ENGLISH_READING_DIR = path.join(dir, "reading");
});
afterEach(() => {
  delete process.env.ENGLISH_VOCAB_PATH;
  delete process.env.ENGLISH_READING_DIR;
});

describe("词汇判卷：只认确定的写法", () => {
  // 用测试自带的词卡，不依赖仓库里正在变的那份词表
  const apple = { id: "w-apple", zh: "苹果", en: "apple", cefr: "A1", example: "I ate an apple after lunch." };

  it("大小写与句末标点不影响，拼错就是错", () => {
    expect(judgeVocab(apple, "zh2en", "APPLE").correct).toBe(true);
    expect(judgeVocab(apple, "zh2en", "apple.").correct).toBe(true);
    expect(judgeVocab(apple, "zh2en", "apples").correct).toBe(false);
    expect(judgeVocab(apple, "en2zh", "苹果").correct).toBe(true);
    expect(judgeVocab(apple, "en2zh", "一个苹果").correct).toBe(false);
  });

  it("多词搭配中间的空格不影响（ice cream）", () => {
    const icecream = { id: "w-icecream", zh: "冰淇淋", en: "ice cream", cefr: "A1", example: "We had ice cream." };
    expect(judgeVocab(icecream, "zh2en", "Ice  Cream").correct).toBe(true);
  });
});

describe("SM-2：第一天不算记住", () => {
  it("新词答对也只是排到明天——今天只是见过一面", () => {
    const { repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    const progress = recordVocabAnswer(repo, learner.id, "w-apple", true);
    expect(progress.stage).toBe(0);
    expect(progress.mastered).toBe(false);
    expect(new Date(progress.nextReviewAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("答错退回明天再来，答对逐档推进", () => {
    const { repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    recordVocabAnswer(repo, learner.id, "w-apple", true);
    const second = recordVocabAnswer(repo, learner.id, "w-apple", true);
    expect(second.stage).toBe(1);
    const back = recordVocabAnswer(repo, learner.id, "w-apple", false);
    expect(back.stage).toBeLessThan(second.stage);
    expect(back.mastered).toBe(false);
  });

  it("走完全部间隔才算 mastered", () => {
    const { repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    let progress = recordVocabAnswer(repo, learner.id, "w-apple", true);
    for (let i = 0; i < 8 && !progress.mastered; i++) {
      progress = recordVocabAnswer(repo, learner.id, "w-apple", true);
    }
    expect(progress.mastered).toBe(true);
    expect(progress.nextReviewAt).toBeNull();
  });
});

describe("今天的词卡", () => {
  it("新词有每天上限，不会一次把整本词表倒给孩子", () => {
    const { repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    const many = Array.from({ length: NEW_WORDS_PER_DAY + 5 }, (_, i) => ({
      id: `w-${i}`,
      zh: `词${i}`,
      en: `word${i}`,
      cefr: "A1",
      example: `This is word${i}.`,
    }));
    const batch = vocabBatch(repo, learner.id, many);
    expect(batch.newWords).toHaveLength(NEW_WORDS_PER_DAY);
    expect(batch.stats.total).toBe(many.length);
  });

  it("学过的词不再当新词；到期了才进复习", () => {
    const { repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    recordVocabAnswer(repo, learner.id, "w-apple", true);
    const now = vocabBatch(repo, learner.id, loadVocabulary());
    expect(now.newWords.map((w) => w.card.id)).not.toContain("w-apple");
    // 刚学完还没到期
    expect(now.reviews.map((r) => r.card.id)).not.toContain("w-apple");

    const later = vocabBatch(repo, learner.id, loadVocabulary(), new Date(Date.now() + 3 * 86400_000));
    expect(later.reviews.map((r) => r.card.id)).toContain("w-apple");
  });
});

describe("分级阅读：答案必须在原文里", () => {
  const good = {
    id: "r-a1-test",
    title: "A Test",
    level: "A1",
    text: "Tom gets up at seven o'clock. He eats bread for breakfast.",
    questions: [
      { id: "q1", prompt: "What time does Tom get up?", answer: "At seven o'clock / 7:00", evidence: "Tom gets up at seven o'clock." },
      // evidence 不在原文里 → 加载时丢掉
      { id: "q2", prompt: "What does Tom eat?", answer: "bread", evidence: "Tom eats noodles every day." },
    ],
  };

  it("没有出处的题不进题库", () => {
    writeFileSync(path.join(dir, "reading", "a1-test.json"), JSON.stringify(good), "utf8");
    const loaded = loadReading();
    expect(loaded.passages).toHaveLength(1);
    expect(loaded.passages[0]!.questions.map((q) => q.id)).toEqual(["q1"]);
    expect(loaded.dropped[0]?.questionId).toBe("q2");
  });

  it("判卷按备选写法逐个比，答错不给原文", () => {
    const q = { id: "q1", prompt: "p", answer: "At seven o'clock / 7:00", evidence: "e" };
    expect(judgeReading(q, "at seven o'clock").correct).toBe(true);
    expect(judgeReading(q, "7:00").correct).toBe(true);
    expect(judgeReading(q, "six").correct).toBe(false);
  });
});

describe("接口", () => {
  it("今天的词卡 → 作答 → 进度；答错给例句", async () => {
    const { app, repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");

    const today = (await (await app.request(`/api/v1/en/vocabulary/today?learnerId=${learner.id}`)).json()) as {
      newWords: { card: { id: string } }[];
    };
    expect(today.newWords.length).toBeGreaterThan(0);

    const wrong = (await (
      await app.request("/api/v1/en/vocabulary/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerId: learner.id, wordId: "w-apple", answer: "banana", direction: "zh2en" }),
      })
    ).json()) as { correct: boolean; reference: string; example?: string; verification: string };
    expect(wrong.correct).toBe(false);
    expect(wrong.reference).toBe("apple");
    expect(wrong.example).toContain("apple");
    expect(wrong.verification).toBe("reference");
  });

  it("阅读：孩子看到的短文不带答案与证据", async () => {
    writeFileSync(path.join(dir, "reading", "a1-test.json"), JSON.stringify({
      id: "r-a1-test", title: "A Test", level: "A1",
      text: "Tom gets up at seven o'clock.",
      questions: [{ id: "q1", prompt: "What time?", answer: "seven", evidence: "Tom gets up at seven o'clock." }],
    }), "utf8");
    const { app } = makeApp([]);
    const body = (await (await app.request("/api/v1/en/reading/passage?id=r-a1-test")).json()) as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("\"answer\"");
    expect(serialized).not.toContain("evidence");
  });

  it("阅读作答：答对才给原文依据，答错只给一句提示", async () => {
    writeFileSync(path.join(dir, "reading", "a1-test.json"), JSON.stringify({
      id: "r-a1-test", title: "A Test", level: "A1",
      text: "Tom gets up at seven o'clock.",
      questions: [{ id: "q1", prompt: "What time?", answer: "seven o'clock / 7:00", evidence: "Tom gets up at seven o'clock." }],
    }), "utf8");
    const { app, repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");

    const wrong = (await (await app.request("/api/v1/en/reading/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId: learner.id, passageId: "r-a1-test", questionId: "q1", answer: "six" }),
    })).json()) as { correct: boolean; evidence?: string; hint?: string };
    expect(wrong.correct).toBe(false);
    expect(wrong.evidence).toBeUndefined();
    expect(wrong.hint).toBeTruthy();

    const right = (await (await app.request("/api/v1/en/reading/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId: learner.id, passageId: "r-a1-test", questionId: "q1", answer: "7:00" }),
    })).json()) as { correct: boolean; evidence?: string };
    expect(right.correct).toBe(true);
    expect(right.evidence).toContain("seven o'clock");
  });

  it("重答（再记一次）不推进 SM-2：看过答案后的\"对\"不能当排期依据", async () => {
    const { app, repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    const call = (body: Record<string, unknown>) =>
      app.request("/api/v1/en/vocabulary/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerId: learner.id, wordId: "w-apple", direction: "zh2en", ...body }),
      });

    // 先答错：进度记下这一次，排到明天
    const wrong = (await (await call({ answer: "banana" })).json()) as { progress: { stage: number } };
    expect(wrong.progress.stage).toBe(0);

    // 再记一次答对：判卷说对，但进度不动（progress 为 null，明确不是"升级"）
    const retry = (await (await call({ answer: "apple", retry: true })).json()) as {
      correct: boolean;
      progress: unknown;
      retry: boolean;
    };
    expect(retry.correct).toBe(true);
    expect(retry.retry).toBe(true);
    expect(retry.progress).toBeNull();

    // 事件里标了 retry，家长回看能分辨"这次是照着答案写的"
    const events = repo.listEvents(learner.id, "vocab-answer");
    expect(events.some((e) => (e.payload as { retry?: boolean }).retry === true)).toBe(true);
  });

  it("阅读接口也受模块开关管：关掉英语，列表与作答都 403", async () => {
    writeFileSync(path.join(dir, "reading", "a1-test.json"), JSON.stringify({
      id: "r-a1-test", title: "A Test", level: "A1",
      text: "Tom gets up at seven o'clock.",
      questions: [{ id: "q1", prompt: "What time?", answer: "seven", evidence: "Tom gets up at seven o'clock." }],
    }), "utf8");
    const { app, repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    repo.setLearnerPrefs(learner.id, { modules: { english: false } });

    const list = await app.request(`/api/v1/en/reading/list?learnerId=${learner.id}`);
    expect(list.status).toBe(403);

    const answer = await app.request("/api/v1/en/reading/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId: learner.id, passageId: "r-a1-test", questionId: "q1", answer: "seven" }),
    });
    expect(answer.status).toBe(403);
  });

  it("家长关掉英语模块：入口 403，且说的话孩子看得懂", async () => {
    const { app, repo } = makeApp([]);
    const learner = repo.createLearner("小测", "elementary_upper");
    repo.setLearnerPrefs(learner.id, { modules: { english: false } });
    const res = await app.request(`/api/v1/en/vocabulary/today?learnerId=${learner.id}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("英语");
  });
});
