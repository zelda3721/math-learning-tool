import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 分级阅读：短文 + 能从原文里找到答案的理解题。
 *
 * 这个模块只做一件事——**把"有标准答案"这件事变得可核对**：
 * 每道题的答案必须能在短文里指出出处（`evidence` 逐字是 text 的子串）。
 * 找不到出处的题在加载时就被丢掉：一道问"作者怎么想"却没有原文依据的题，
 * 判对了也只是判"跟我的参考答案像"，而那正是英语阅读最容易骗自己的地方。
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface ReadingQuestion {
  id: string;
  prompt: string;
  /** 可接受的多种写法，` / ` 分隔 */
  answer: string;
  /** 原文里能逐字找到的那一句：这是这道题的判卷依据 */
  evidence: string;
}

export interface ReadingPassage {
  id: string;
  title: string;
  level: string;
  text: string;
  questions: ReadingQuestion[];
}

export interface LoadedReading {
  passages: ReadingPassage[];
  /** 加载时被丢掉的题（缺证据、证据对不上原文），给家长和日志看 */
  dropped: { passageId: string; questionId: string; why: string }[];
}

export function readingDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGLISH_READING_DIR
    ? path.resolve(repoRoot, env.ENGLISH_READING_DIR)
    : path.join(repoRoot, "subjects", "english", "content", "reading");
}

/** 空白、引号、句末标点归一：用来判断 evidence 是不是原文的一部分（不改变词序） */
export function normalizePassage(raw: string): string {
  return raw
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function locateEvidence(text: string, evidence: string): boolean {
  const hay = normalizePassage(text).toLowerCase();
  const needle = normalizePassage(evidence).toLowerCase();
  return needle.length > 0 && hay.includes(needle);
}

export function loadReading(env: NodeJS.ProcessEnv = process.env): LoadedReading {
  const dir = readingDir(env);
  const dropped: LoadedReading["dropped"] = [];
  const passages: ReadingPassage[] = [];
  if (!existsSync(dir)) return { passages, dropped };

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      console.warn(`[reading] ${file} 解析失败：${String(err)}`);
      continue;
    }
    const item = raw as Partial<ReadingPassage>;
    if (!item.id || !item.text || !Array.isArray(item.questions)) continue;

    const questions: ReadingQuestion[] = [];
    for (const q of item.questions) {
      const question = q as Partial<ReadingQuestion>;
      if (!question.id || !question.prompt || !question.answer) continue;
      /*
       * 证据不在原文里 → 这道题不进题库。宁可这一篇少一道题，
       * 也不能出一道"答案没有出处"的题：那种题一旦判错，孩子没有任何办法自证。
       */
      if (!question.evidence || !locateEvidence(item.text, question.evidence)) {
        dropped.push({
          passageId: String(item.id),
          questionId: String(question.id),
          why: question.evidence ? "evidence 不在原文里" : "缺 evidence",
        });
        continue;
      }
      questions.push({
        id: String(question.id),
        prompt: String(question.prompt),
        answer: String(question.answer),
        evidence: String(question.evidence),
      });
    }
    if (questions.length === 0) continue;

    passages.push({
      id: String(item.id),
      title: String(item.title ?? item.id),
      level: String(item.level ?? "A1"),
      text: String(item.text),
      questions,
    });
  }

  return { passages, dropped };
}

/** 判一道阅读题：答案必须命中某一种可接受写法 */
export function judgeReading(
  question: ReadingQuestion,
  response: string,
): { correct: boolean; reference: string } {
  const normalize = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .replace(/[‘’´`]/g, "'")
      .replace(/\s+/g, " ")
      .replace(/^[\s.。!！?？,，;；"“”]+|[\s.。!！?？,，;；"“”]+$/g, "");
  const accepted = question.answer
    .split("/")
    .map((s) => normalize(s))
    .filter(Boolean);
  return { correct: accepted.includes(normalize(response)), reference: question.answer };
}

/** 给孩子的阅读视图：**不带答案与证据**（证据在孩子答完之后才出现，那才是讲解） */
export function publicPassage(passage: ReadingPassage): {
  id: string;
  title: string;
  level: string;
  text: string;
  questions: { id: string; prompt: string }[];
} {
  return {
    id: passage.id,
    title: passage.title,
    level: passage.level,
    text: passage.text,
    questions: passage.questions.map((q) => ({ id: q.id, prompt: q.prompt })),
  };
}
