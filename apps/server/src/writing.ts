import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HintProvider } from "./hint.js";

/**
 * 英语写作（阶段 5）。
 *
 * 写作是英语里唯一**判不了对错**的东西：同一段话可以这么写，也可以那么写。
 * 所以按 PLAN 的 D9 处理——`ai_unverified`：给反馈、给建议、家长可抽查，
 * 但**不进掌握度、不点亮星**。界面必须把这句话说出来，不能让孩子以为
 * "AI 说不错"就等于"我会了"。
 *
 * 量规三条（结构 / 词汇 / 语法）各 1–5 分，外加一句能照着改的建议。
 * 两次评分做一致性检查：只看分数区间，不看措辞——措辞不同很正常，
 * 分数差出两档以上说明这次反馈不稳，界面上要说"家长可以看一眼"。
 */

export interface WritingPrompt {
  id: string;
  title: string;
  level: string;
  prompt: string;
  minWords: number;
  mustUse: string[];
  tips: string[];
}

export interface WritingBands {
  structure: number;
  vocabulary: number;
  grammar: number;
}

export interface WritingFeedback {
  bands: WritingBands;
  /** 一句能照着改的建议（务必具体到某一处） */
  tip: string;
  /** 说得好的地方，一句 */
  praise: string;
  /** 两次评分差出两档：这次反馈不稳 */
  inconsistent: boolean;
  words: number;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function writingContentPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGLISH_WRITING_PATH
    ? path.resolve(repoRoot, env.ENGLISH_WRITING_PATH)
    : path.join(repoRoot, "subjects", "english", "content", "writing.json");
}

let cached: WritingPrompt[] | null = null;

export function loadWriting(file = writingContentPath()): WritingPrompt[] {
  if (cached) return cached;
  if (!existsSync(file)) {
    console.warn(`[writing] 写作题文件不存在：${file}`);
    return [];
  }
  try {
    cached = JSON.parse(readFileSync(file, "utf8")) as WritingPrompt[];
    return cached;
  } catch (err) {
    console.warn(`[writing] 写作题读不出来：${String(err)}`);
    return [];
  }
}

export function writingPromptById(id: string): WritingPrompt | undefined {
  return loadWriting().find((p) => p.id === id);
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function bandPrompt(task: WritingPrompt, text: string): string {
  return `你在给一个中国孩子批改英语写作。任务：${task.prompt}
孩子的作文：
"""
${text}
"""
按三条量规各给 1–5 分（1=还没掌握，3=基本能读懂，5=这个水平的范文）：
structure（有没有开头、顺序、结尾）、vocabulary（用词是否准确、是否够用）、
grammar（时态、单复数、句子是否成句）。
再给一句**具体**的建议（指出某一处怎么改，不要说"多练习"这种空话），
以及一句说得好的地方。
只输出 JSON，不要解释：
{"structure":3,"vocabulary":3,"grammar":3,"tip":"……","praise":"……"}`;
}

function bandsOnlyPrompt(task: WritingPrompt, text: string): string {
  return `再评一次这篇英语作文（任务：${task.prompt}）。这次只给分数，不要点评。
作文：
"""
${text}
"""
只输出 JSON：{"structure":3,"vocabulary":3,"grammar":3}`;
}

function parseJson(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const clampBand = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
};

/**
 * 批一次写作。没有模型就返回 null——写作反馈没法用规则替代，
 * 假装给一分比不给更糟。
 */
export async function reviewWriting(
  llm: HintProvider | null,
  task: WritingPrompt,
  text: string,
): Promise<WritingFeedback | null> {
  if (!llm) return null;
  const words = countWords(text);
  let first: Record<string, unknown> | null = null;
  try {
    first = parseJson(await llm.generate(bandPrompt(task, text)));
  } catch {
    first = null;
  }
  if (!first) return null;
  const bands: WritingBands = {
    structure: clampBand(first.structure),
    vocabulary: clampBand(first.vocabulary),
    grammar: clampBand(first.grammar),
  };

  // 第二次只取分数，用来做一致性检查
  let inconsistent = false;
  try {
    const second = parseJson(await llm.generate(bandsOnlyPrompt(task, text)));
    if (second) {
      const again = {
        structure: clampBand(second.structure),
        vocabulary: clampBand(second.vocabulary),
        grammar: clampBand(second.grammar),
      };
      const drift = Math.max(
        Math.abs(again.structure - bands.structure),
        Math.abs(again.vocabulary - bands.vocabulary),
        Math.abs(again.grammar - bands.grammar),
      );
      inconsistent = drift >= 2;
    }
  } catch {
    /* 第二次失败不影响第一次的反馈，只是少了这层检查 */
  }

  return {
    bands,
    tip: typeof first.tip === "string" ? first.tip.slice(0, 160) : "挑一句最长的句子，看看时态和单复数对不对。",
    praise: typeof first.praise === "string" ? first.praise.slice(0, 120) : "写完了就是好的开始。",
    inconsistent,
    words,
  };
}
