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

/**
 * 三条量规分。`null` = 模型这一维没给分。
 *
 * 早先缺分一律补 3——"基本能读懂"是一个实打实的评价，模型没说过的话不能替它说；
 * 界面拿到 null 显示"—"，家长一眼看得出这一维是空的。
 */
export interface WritingBands {
  structure: number | null;
  vocabulary: number | null;
  grammar: number | null;
}

/** 任务硬要求的确定性检查：不问模型，数得出来的事就自己数 */
export interface WritingRequirements {
  mustUseHit: string[];
  mustUseMissing: string[];
  belowMinWords: boolean;
}

export interface WritingFeedback {
  bands: WritingBands;
  /** 一句能照着改的建议（务必具体到某一处） */
  tip: string;
  /** 说得好的地方，一句 */
  praise: string;
  /**
   * 两次评分差出两档：这次反馈不稳。
   * `null` = 第二次没评出来（或没有能比的维度），一致性**未知**——不能报成"一致"。
   */
  inconsistent: boolean | null;
  words: number;
  requirements: WritingRequirements;
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

const clampBand = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
};

const bandsOf = (raw: Record<string, unknown>): WritingBands => ({
  structure: clampBand(raw.structure),
  vocabulary: clampBand(raw.vocabulary),
  grammar: clampBand(raw.grammar),
});

/** 归一成"小写、只留字母数字与空格"，用来比较词序列 */
const flatWords = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’´`]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * mustUse / minWords：确定性检查。
 *
 * 这两条是任务写死的硬要求，数一下就知道，不该交给模型"看着评"——
 * 模型说"用得很好"而孩子根本没写 There are，这种反馈比没有更误导。
 */
export function checkRequirements(task: WritingPrompt, text: string): WritingRequirements {
  const hay = ` ${flatWords(text)} `;
  const mustUseHit: string[] = [];
  const mustUseMissing: string[] = [];
  for (const phrase of task.mustUse ?? []) {
    const needle = flatWords(phrase);
    // 前后补空格做整词匹配：mustUse "is" 不该被 "this" 命中
    (needle && hay.includes(` ${needle} `) ? mustUseHit : mustUseMissing).push(phrase);
  }
  return { mustUseHit, mustUseMissing, belowMinWords: countWords(text) < (task.minWords ?? 0) };
}

/**
 * 模型回复里有没有**算式结果**（"37×24=888"、"37 times 24 is 888"、或整句只剩数字和运算符）。
 *
 * 写作与口语都接着模型，孩子很快会发现"帮我算 37×24"在这里也能用——
 * 英语模块就成了绕过数学提示阶梯的通用解题通道。拦的是"算出结果"的形态，
 * 不拦普通数字（"I have 2 cats" 照常）。
 */
export function containsMathAnswer(text: string): boolean {
  const s = text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const num = String.raw`-?\d+(?:[.,]\d+)?`;
  const op = String.raw`[+\-−×xX*÷/／＋－]`;
  if (new RegExp(`${num}\\s*${op}\\s*${num}(?:\\s*${op}\\s*${num})*\\s*[=＝]\\s*${num}`).test(s)) return true;
  if (
    new RegExp(
      `${num}\\s*(?:times|plus|minus|multiplied by|divided by|乘以?|加上?|减去?|除以)\\s*${num}\\s*(?:is|equals|makes|等于|得)\\s*${num}`,
      "i",
    ).test(s)
  ) {
    return true;
  }
  // 带算式再报结果："37*24 is 888"、"37×24的结果是888"
  if (new RegExp(`${num}\\s*${op}\\s*${num}[^\\d]{0,12}?(?:is|equals|makes|是|等于|得)\\s*${num}`, "i").test(s)) return true;
  // 直接报答案的句式："The answer is 888"、"It's 888!"、"答案是 888"
  if (new RegExp(`(?:\\banswer\\s+is|\\bit(?:'s|\\s+is)|\\bthat(?:'s|\\s+is)|答案是|结果是|等于)\\s*${num}\\s*[.!。！]?\\s*$`, "i").test(s)) return true;
  // 英文数词版："Ten times two is twenty"
  const word = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine|hundred))*`;
  if (new RegExp(`\\b${word}\\s+(?:times|plus|minus|multiplied by|divided by)\\s+${word}\\s+(?:is|equals|makes)\\s+${word}\\b`, "i").test(s)) return true;
  // 纯算式/纯结果：整句只有数字、运算符和标点（"888"、"= 888"）
  return /\d/.test(s) && /^[\s\d+\-−×xX*÷/=＝().,，。:：!！?？]+$/.test(s);
}

/** 至少 6 个连续英文单词（中间只允许空格、逗号、撇号）：一段成句的英文 */
const ENGLISH_RUN = /[A-Za-z][A-Za-z']*(?:[\s,]+[A-Za-z][A-Za-z']*){5,}/g;

/** 作文按句切开（给"看看第 N 句"定位用） */
function essaySentences(essay: string): string[] {
  return essay
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 这段英文和作文的哪一句最像（实词重合最多）；一处都对不上返回 undefined */
function closestSentence(run: string, essay: string): number | undefined {
  const runWords = new Set(flatWords(run).split(" ").filter((w) => w.length >= 3));
  let best: number | undefined;
  let bestHits = 0;
  essaySentences(essay).forEach((sentence, i) => {
    const hits = flatWords(sentence)
      .split(" ")
      .filter((w) => w.length >= 3 && runWords.has(w)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = i + 1;
    }
  });
  return best;
}

export const WRITING_FALLBACK = {
  tip: "挑一句最长的句子，看看时态和单复数对不对。",
  praise: "写完了就是好的开始。",
  /** 模型的话里有不该给孩子看的内容 */
  blocked: "这条反馈先收回了。自己再读一遍作文，找一处想改的地方。",
  /** 模型在写作反馈里算起了数学题 */
  math: "这里只看英语写作。挑一句最长的句子，看看时态和单复数对不对。",
} as const;

/**
 * 给孩子看之前，tip / praise 各过一遍：
 * ① 安全安检（screen 回调，接 screenModelOutput）——拦下就换固定话术；
 * ② 算式结果 → 固定话术（见 containsMathAnswer）；
 * ③ 成段英文（≥6 个连续英文单词）且**不是孩子自己写过的原句** → 视为"替孩子写了"，
 *    换成只指位置的提示。写作要孩子自己写出来；模型把改好的整句端上来，
 *    孩子抄一遍就交差了，和直接给答案没区别。引用孩子自己的原句不算（那是在指位置）。
 */
export function guardFeedbackLine(
  line: string,
  kind: "tip" | "praise",
  essay: string,
  screen?: (s: string) => boolean,
): string {
  if (screen?.(line)) return WRITING_FALLBACK.blocked;
  if (containsMathAnswer(line)) return WRITING_FALLBACK.math;
  const own = ` ${flatWords(essay)} `;
  for (const match of line.matchAll(ENGLISH_RUN)) {
    const run = flatWords(match[0]);
    if (run && own.includes(` ${run} `)) continue;
    const n = closestSentence(match[0], essay);
    if (kind === "tip") {
      return n
        ? `看看第 ${n} 句：自己读一遍，找找时态、单复数或用词哪里可以改。`
        : "回到作文里，挑一句自己读一遍，找找时态、单复数或用词哪里可以改。";
    }
    return n ? `第 ${n} 句写得不错。` : WRITING_FALLBACK.praise;
  }
  return line;
}

/**
 * 批一次写作。没有模型就返回 null——写作反馈没法用规则替代，
 * 假装给一分比不给更糟。
 *
 * `screen`：输出侧安检（路由里接 screenModelOutput，拦下返回 true）。
 * 放成回调是因为安检要留痕到具体孩子名下，而这个模块不碰 repo。
 */
export async function reviewWriting(
  llm: HintProvider | null,
  task: WritingPrompt,
  text: string,
  opts: { screen?: (s: string) => boolean } = {},
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
  const bands = bandsOf(first);

  /*
   * 第二次只取分数，用来做一致性检查。
   * 第二次失败（抛错或解析不出）= 一致性未知，记 null；早先默认 false，
   * 等于没检查就报"一致"，家长据此放心，正是这层检查要防的事。
   */
  let inconsistent: boolean | null = null;
  try {
    const second = parseJson(await llm.generate(bandsOnlyPrompt(task, text)));
    if (second) {
      const again = bandsOf(second);
      const dims = (["structure", "vocabulary", "grammar"] as const).filter(
        (k) => bands[k] !== null && again[k] !== null,
      );
      // 两次都给了分的维度才能比；一维都比不了也是"未知"
      if (dims.length > 0) {
        const drift = Math.max(...dims.map((k) => Math.abs(again[k]! - bands[k]!)));
        inconsistent = drift >= 2;
      }
    }
  } catch {
    /* 第二次失败不影响第一次的反馈，只是这层检查结果未知 */
  }

  const rawTip = typeof first.tip === "string" && first.tip.trim() ? first.tip : WRITING_FALLBACK.tip;
  const rawPraise = typeof first.praise === "string" && first.praise.trim() ? first.praise : WRITING_FALLBACK.praise;
  return {
    bands,
    tip: guardFeedbackLine(rawTip, "tip", text, opts.screen).slice(0, 160),
    praise: guardFeedbackLine(rawPraise, "praise", text, opts.screen).slice(0, 120),
    inconsistent,
    words,
    requirements: checkRequirements(task, text),
  };
}
