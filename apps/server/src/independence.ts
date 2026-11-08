import type { EvidenceAttempt } from "./evidence.js";

/**
 * 「孩子是在自己学，还是在依赖 AI」——家长端唯一缺的那块信号。
 *
 * 为什么要把这件事做成一份报告而不是一句鼓励：报告里六条偏差里有两条
 * （不度量依赖、家长看不出学习是否真的发生）互相咬着。没有这组数字，
 * "辅助不依赖"就只能靠感觉；有了它，家长能看见**提示是不是在减少**、
 * 新题是不是自己第一次就做对、问解题机问得多不多。
 *
 * 口径全部来自已有记录（attempts / analysis_view / ask_jobs / reflection），
 * 不额外让模型判任何东西：这里是统计，不是评价。
 */

export interface IndependenceInput {
  /** 孩子的作答（家长试做已被 evidence 层排除，这里再排一次更保险） */
  attempts: EvidenceAttempt[];
  questions: { byId: Map<string, { nodeIds: string[] }> };
  /** questionId → 看过解析的时刻（升序） */
  analysisViews: Map<string, string[]>;
  /** 「问一道题」次数 */
  askCount: number;
  /** 同题同日的重复作答次数 */
  repeats: number;
  reflections: { selfExplain: number; errorGuess: number };
}

export interface IndependenceReport {
  attempts: number;
  /** 出现过的新题数（每个问题只算第一次见） */
  firstSeenQuestions: number;
  /** 其中「第一次见 + 零提示 + 没看过解析 + 一次做对」的数量 */
  independentFirstCorrect: number;
  /** 0..1；没有新题时是 null，不拿 0 冒充"不会" */
  independentRate: number | null;
  /** 用了 0/1/2/3 级提示的作答数 */
  hintDistribution: [number, number, number, number];
  analysisViews: number;
  askCount: number;
  repeats: number;
  selfExplain: number;
  errorGuess: number;
  /** 给家长看的一句话（统计结论，不是评价） */
  verdict: string;
}

function countsAsAttempt(a: EvidenceAttempt): boolean {
  if (a.actor === "parent") return false;
  if (a.verification === "ai_unverified") return false;
  return !a.needsReview;
}

export function buildIndependenceReport(input: IndependenceInput): IndependenceReport {
  /*
   * 先用**全部**作答定"第一次见"，再过滤计数——和 evidence.ts 的 firstSeenAt 同一口径。
   *
   * 早先是先过滤再定首见：孩子第一次乱填（判不准进抽检）、第二天再认真做，
   * 第二次就被当成"第一次见就做对"。可那道题他已经见过了。
   * 首见那次本身不算数（抽检中 / 家长试做 / 只有 AI 判断）时，这道题就不进新题分母：
   * 它的"第一手"已经没有可信的数据了，拿后来那次冒充只会把独立率抬高。
   */
  const firstAt = new Map<string, string>();
  for (const a of input.attempts) {
    const prev = firstAt.get(a.questionId);
    if (prev === undefined || a.at < prev) firstAt.set(a.questionId, a.at);
  }
  const attempts = input.attempts.filter(countsAsAttempt).sort((a, b) => a.at.localeCompare(b.at));

  let firstSeenQuestions = 0;
  let independentFirstCorrect = 0;
  const hints: [number, number, number, number] = [0, 0, 0, 0];
  for (const a of attempts) {
    const level = Math.min(3, Math.max(0, Math.trunc(a.hintLevelUsed))) as 0 | 1 | 2 | 3;
    hints[level]++;
    if (firstAt.get(a.questionId) !== a.at) continue;
    firstSeenQuestions++;
    const views = input.analysisViews.get(a.questionId) ?? [];
    const viewedBefore = views.some((t) => t <= a.at);
    if (a.correct && a.hintLevelUsed === 0 && !viewedBefore) independentFirstCorrect++;
  }

  const independentRate = firstSeenQuestions > 0 ? independentFirstCorrect / firstSeenQuestions : null;
  const rate = independentRate;
  let verdict: string;
  if (rate === null) {
    verdict = "还没有新题的第一手数据——做过几道新题之后这里才说得上话。";
  } else if (rate >= 0.7) {
    verdict = `新题里 ${Math.round(rate * 100)}% 是他自己第一次就做对的：多数时候在独立思考。`;
  } else if (rate >= 0.4) {
    verdict = `新题里 ${Math.round(rate * 100)}% 是他自己第一次就做对的：一半靠自己，一半需要提示。`;
  } else {
    verdict = `新题里只有 ${Math.round(rate * 100)}% 是他自己第一次就做对的——先看看是读题卡住，还是太早要提示。`;
  }
  if (input.askCount > 0 && input.askCount >= Math.max(3, attempts.length * 0.3)) {
    verdict += `「问一道题」用了 ${input.askCount} 次，偏多；可以先让他自己做一次再来问。`;
  }
  if (input.repeats > Math.max(2, attempts.length * 0.5)) {
    verdict += `同一道题重复交了很多次（${input.repeats} 次）——那几次不算证据，只看第一次就好。`;
  }

  return {
    attempts: attempts.length,
    firstSeenQuestions,
    independentFirstCorrect,
    independentRate,
    hintDistribution: hints,
    analysisViews: [...input.analysisViews.values()].reduce((n, list) => n + list.length, 0),
    askCount: input.askCount,
    repeats: input.repeats,
    selfExplain: input.reflections.selfExplain,
    errorGuess: input.reflections.errorGuess,
    verdict,
  };
}
