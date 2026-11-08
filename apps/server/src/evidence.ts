import { MASTERY_PARAMS } from "@mathtutor/schema";
import { litByEvidence, type EvidenceStats, type MasteryBand } from "./mastery.js";

/**
 * 证据账本（宪法第 1 条：理解由行为验证，不等于"做对过几次"）。
 *
 * 为什么要有这一层：点亮原来只看 `p ≥ 0.7 且 evidenceN ≥ 3`。同一道题重交三次、
 * 看完解析再做原题、刚看完讲解就做变式，全都按满额计分——测到的是记忆和重复，
 * 不是理解。这里把「独立证据」从作答历史里**推导**出来，不改表结构：
 *
 * - 同一道题同一天只算第一次（订正过程不再被连续扣分，也不能靠重交刷证据）
 * - 只有主节点算独立证据（一题挂几个节点，其余节点跟着沾光的问题）
 * - 零提示、作答前没看过这道题的解析、且这道题是孩子第一次见到
 *
 * 推导而不是新增一列：历史作答已经足够回答这些问句，而多存一份状态就多一处
 * 会和历史对不上的地方（判卷器修过以后尤其明显）。
 */

/** 推导所需的最小作答视图（repo.attemptsForEvidence 的返回） */
export interface EvidenceAttempt {
  questionId: string;
  correct: boolean;
  hintLevelUsed: number;
  at: string;
  source: string;
  verification: string;
  needsReview: boolean;
  /** 'parent' 是家长试做：留痕但不进证据 */
  actor?: string;
}

const dayKey = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** 这条作答能不能进证据（与 /submit 的 counted 同一套纪律） */
export function countsAsEvidence(a: EvidenceAttempt): boolean {
  if (a.actor === "parent") return false;
  if (a.verification === "ai_unverified") return false;
  if (a.needsReview) return false;
  return true;
}

/**
 * 同题同日去重：同一道题同一天只认第一次作答。
 *
 * 这既是防刷（重交三次不能点亮），也是修一个更隐蔽的伤害：
 * 订正时每交一次都按答错 ×0.6 扣分，一道题能把本来就点亮的星打回暗。
 */
export function dedupeSameQuestionSameDay(attempts: EvidenceAttempt[]): EvidenceAttempt[] {
  const seen = new Set<string>();
  const sorted = [...attempts].sort((a, b) => a.at.localeCompare(b.at));
  const out: EvidenceAttempt[] = [];
  for (const a of sorted) {
    const key = `${a.questionId}@${dayKey(a.at)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export interface EvidenceQuestion {
  nodeIds: string[];
}

/**
 * 每道题的「第一次见到」时刻：取**全部**作答（含不算证据的那些）里最早的一次。
 * 孩子先乱填过一次再认真做，那道题就不再是"未见题"——这是诚实的。
 */
function firstSeenAt(attempts: EvidenceAttempt[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of attempts) {
    const prev = map.get(a.questionId);
    if (prev === undefined || a.at < prev) map.set(a.questionId, a.at);
  }
  return map;
}

/** 每个节点已经有多少条计入的证据（归因要用它判断"有没有实证"，且必须排除本次错题） */
export function nodeEvidenceCounts(
  attempts: EvidenceAttempt[],
  questions: { byId: Map<string, EvidenceQuestion> },
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of dedupeSameQuestionSameDay(attempts.filter(countsAsEvidence))) {
    const q = questions.byId.get(a.questionId);
    if (!q) continue;
    for (const nodeId of q.nodeIds) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
  }
  return counts;
}

/** 按节点汇总证据；`analysisViews` 是 questionId → 看过解析的时刻（升序） */
export function evidenceStatsByNode(
  attempts: EvidenceAttempt[],
  questions: { byId: Map<string, EvidenceQuestion> },
  analysisViews: Map<string, string[]>,
): Map<string, EvidenceStats> {
  const firstSeen = firstSeenAt(attempts);
  const counted = dedupeSameQuestionSameDay(attempts.filter(countsAsEvidence));
  const stats = new Map<string, EvidenceStats>();
  const independentAt = new Map<string, string[]>();
  const independentQuestions = new Map<string, Set<string>>();

  for (const a of counted) {
    const q = questions.byId.get(a.questionId);
    if (!q) continue;
    const seenAt = firstSeen.get(a.questionId);
    const views = analysisViews.get(a.questionId) ?? [];
    const viewedBefore = views.some((t) => t <= a.at);
    q.nodeIds.forEach((nodeId, index) => {
      const s = stats.get(nodeId) ?? { counted: 0, independent: 0, distinctQuestions: 0, spanDays: 0, hasFirstSeen: false };
      s.counted++;
      const independent =
        index === 0 && a.correct && a.hintLevelUsed === 0 && !viewedBefore;
      if (independent) {
        s.independent++;
        const ats = independentAt.get(nodeId) ?? [];
        ats.push(a.at);
        independentAt.set(nodeId, ats);
        const qs = independentQuestions.get(nodeId) ?? new Set<string>();
        qs.add(a.questionId);
        independentQuestions.set(nodeId, qs);
        // 「未见题上做对」：这一次就是这个孩子第一次见这道题
        if (seenAt !== undefined && a.at === seenAt) s.hasFirstSeen = true;
      }
      stats.set(nodeId, s);
    });
  }

  for (const [nodeId, s] of stats) {
    const ats = independentAt.get(nodeId) ?? [];
    const days = new Set(ats.map(dayKey));
    s.spanDays = days.size > 1 ? days.size - 1 : 0;
    s.distinctQuestions = (independentQuestions.get(nodeId) ?? new Set()).size;
  }
  return stats;
}

/** 从库里读作答与解析查看记录，一次算出全部节点的证据统计 */
export function loadEvidenceStats(
  repo: {
    attemptsForEvidence(learnerId: string): EvidenceAttempt[];
    analysisViews(learnerId: string): Map<string, string[]>;
  },
  questions: { byId: Map<string, EvidenceQuestion> },
  learnerId: string,
): Map<string, EvidenceStats> {
  return evidenceStatsByNode(repo.attemptsForEvidence(learnerId), questions, repo.analysisViews(learnerId));
}

/** 这道节点现在该不该点亮（判据在 mastery.ts，这里只做转出，避免两处各写一份） */
export { litByEvidence };
export type { EvidenceStats, MasteryBand };
