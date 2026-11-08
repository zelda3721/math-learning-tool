import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_PARAMS } from "@mathtutor/schema";
import type { Repo } from "./repo.js";

/**
 * 英语词汇：词表 + 卡片 + SM-2。
 *
 * 几条决定，都来自"这是给孩子用的，不是词汇量统计工具"：
 *
 * 1. **判卷只认确定的写法**（verification = reference）。词汇卡的答案是词表里印着的，
 *    判对了就是真记得，判错了就是一个明确的"再记一次"。不做"接近就算对"——
 *    宽容匹配会把 apple 和 apples 判成同一件事，孩子于是永远学不会单复数。
 * 2. **进度按词记，不冒充图谱节点**。词不是知识图谱里的节点，硬把它折成节点去推动
 *    掌握度，会让星图上的"已点亮"变得说不清。词的阶段存在复习卡里（targetKind=vocab），
 *    和图谱掌握度是两条线，界面上分开说。
 * 3. **每天的新词有上限**。一次给孩子 96 个词，他能点完，但一个也记不住。
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface VocabCard {
  id: string;
  zh: string;
  en: string;
  cefr: string;
  example: string;
  topic?: string;
}

/** 卡片的两个方向：看英文说中文、看中文写英文。两个方向都练，才算真的会 */
export type VocabDirection = "en2zh" | "zh2en";

export interface VocabProgress {
  stage: number;
  mastered: boolean;
  nextReviewAt: string | null;
}

export interface VocabBatch {
  newWords: { card: VocabCard; direction: VocabDirection }[];
  reviews: { card: VocabCard; direction: VocabDirection; cardId: string }[];
  stats: { total: number; learning: number; mastered: number; dueToday: number };
}

/** 每天最多学几个新词：多了记不住，少了进度慢，取 6 */
export const NEW_WORDS_PER_DAY = 6;
/** 一次最多复习几张：复习是"想起来"，不是刷题 */
export const REVIEWS_PER_SESSION = 12;

export function vocabularyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGLISH_VOCAB_PATH
    ? path.resolve(repoRoot, env.ENGLISH_VOCAB_PATH)
    : path.join(repoRoot, "subjects", "english", "content", "vocabulary.json");
}

/**
 * 读词表。文件坏了就返回空表并打日志——**不要抛**：
 * 词表是学习内容，它出问题时孩子应该还能做题，而不是整个服务起不来。
 */
export function loadVocabulary(env: NodeJS.ProcessEnv = process.env): VocabCard[] {
  const file = vocabularyPath(env);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("词表不是数组");
    const cards: VocabCard[] = [];
    for (const item of raw) {
      const card = item as Partial<VocabCard>;
      if (!card.id || !card.zh || !card.en) continue;
      cards.push({
        id: String(card.id),
        zh: String(card.zh),
        en: String(card.en),
        cefr: String(card.cefr ?? "A1"),
        example: String(card.example ?? ""),
        ...(card.topic ? { topic: String(card.topic) } : {}),
      });
    }
    return cards;
  } catch (err) {
    console.warn(`[vocabulary] 词表读取失败（按空表继续）：${String(err)}`);
    return [];
  }
}

/** 规范化：大小写、首尾空白、句末标点；不纠正拼写、不合并单复数 */
export function normalizeVocabAnswer(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[‘’´`]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/^[\s.。!！?？,，;；]+|[\s.。!！?？,，;；]+$/g, "");
}

/** 参考答案可能给多种写法（用 `/` 分隔），逐个比 */
export function acceptedVocabAnswers(reference: string): string[] {
  return reference
    .split("/")
    .map((s) => normalizeVocabAnswer(s))
    .filter(Boolean);
}

export function judgeVocab(card: VocabCard, direction: VocabDirection, response: string): { correct: boolean; reference: string } {
  const reference = direction === "en2zh" ? card.zh : card.en;
  const accepted = acceptedVocabAnswers(reference);
  const given = normalizeVocabAnswer(response);
  return { correct: accepted.includes(given), reference };
}

/** 卡片 id → 复习卡 id 无关；进度全在 review_cards 里，targetKind = vocab */
export function vocabCardsOf(repo: Repo, learnerId: string): Map<string, { id: string; stage: number; masteredAt: string | null; nextReviewAt: string }> {
  const out = new Map<string, { id: string; stage: number; masteredAt: string | null; nextReviewAt: string }>();
  for (const card of repo.listReviewCardsByKind(learnerId, "vocab")) {
    out.set(card.targetId, { id: card.id, stage: card.stage, masteredAt: card.masteredAt ?? null, nextReviewAt: card.nextReviewAt });
  }
  return out;
}

/** 轮换方向：同一个词这次英→中，下次中→英（单双号决定，确定性、可测） */
export function directionFor(wordId: string): VocabDirection {
  let hash = 0;
  for (const ch of wordId) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return hash % 2 === 0 ? "en2zh" : "zh2en";
}

/**
 * 今天的词卡：先复习到期的，再给新词。
 *
 * 到期判定与 SM-2 同一套口径（next_review_at ≤ 现在，且没 mastered）。
 * 新词按词表顺序取——词表顺序是内容作者定的（由易到难），不该按字母序打乱。
 */
export function vocabBatch(repo: Repo, learnerId: string, cards: VocabCard[], now = new Date()): VocabBatch {
  const progress = vocabCardsOf(repo, learnerId);
  const nowIso = now.toISOString();

  const reviews = [...progress.entries()]
    .filter(([, p]) => !p.masteredAt && p.nextReviewAt <= nowIso)
    .slice(0, REVIEWS_PER_SESSION)
    .map(([wordId, p]) => {
      const card = cards.find((c) => c.id === wordId);
      return card ? { card, direction: directionFor(wordId), cardId: p.id } : null;
    })
    .filter((x): x is { card: VocabCard; direction: VocabDirection; cardId: string } => x !== null);

  const newWords = cards
    .filter((c) => !progress.has(c.id))
    .slice(0, NEW_WORDS_PER_DAY)
    .map((card) => ({ card, direction: directionFor(card.id) }));

  const learning = [...progress.values()].filter((p) => !p.masteredAt).length;
  const mastered = [...progress.values()].filter((p) => Boolean(p.masteredAt)).length;

  return {
    newWords,
    reviews,
    stats: { total: cards.length, learning, mastered, dueToday: reviews.length },
  };
}

/**
 * 答完一张卡：答对进档、答错退回明天再来（与题的 SM-2 同一套参数）。
 *
 * 第一张卡（新词）是"先见过一面"，无论对错都排到明天——今天记住一个词不现实，
 * 明天的复习才是真正的第一次提取练习。
 */
export function recordVocabAnswer(repo: Repo, learnerId: string, wordId: string, correct: boolean): VocabProgress {
  const existing = vocabCardsOf(repo, learnerId).get(wordId);
  const intervals = REVIEW_PARAMS.intervalsDays;
  const now = Date.now();

  if (!existing) {
    const due = new Date(now + intervals[0]! * 86400_000).toISOString();
    repo.upsertReviewCard(learnerId, "vocab", wordId, due);
    return { stage: 0, mastered: false, nextReviewAt: due };
  }

  const stage = correct ? existing.stage + 1 : Math.max(0, existing.stage - REVIEW_PARAMS.wrongStagePenalty);
  if (correct && stage >= intervals.length) {
    repo.masterReviewCard(existing.id);
    return { stage, mastered: true, nextReviewAt: null };
  }
  const days = correct ? intervals[Math.min(stage, intervals.length - 1)]! : 1;
  const due = new Date(now + days * 86400_000).toISOString();
  repo.updateReviewCard(existing.id, {
    stage,
    nextReviewAt: due,
    ...(correct ? {} : { lapseCount: 1 }),
  });
  return { stage, mastered: false, nextReviewAt: due };
}
