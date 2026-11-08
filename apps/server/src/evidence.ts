import { MASTERY_PARAMS } from "@mathtutor/schema";
import { applyAttempt, litByEvidence, masteryBand, type EvidenceStats, type MasteryBand } from "./mastery.js";

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
function firstSeenAt(attempts: EvidenceAttempt[], alsoSeen?: Map<string, string>): Map<string, string> {
  // 测评里见过的题也算"见过"（测评交卷时还看了参考答案）
  const map = new Map<string, string>(alsoSeen ?? []);
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
  /** 作答之外"见过这道题"的时刻（目前是测评）：questionId → ISO */
  alsoSeen?: Map<string, string>,
): Map<string, EvidenceStats> {
  const firstSeen = firstSeenAt(attempts, alsoSeen);
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
      /*
       * 独立证据只认**这道题第一次见的那一次**。
       *
       * 早先只要求"至少一条独立证据是首见"，其余可以是旧题隔天再做——
       * 一道首见题加两道早就见过的题也能凑够"≥2 道不同题"，测到的又是记忆。
       * 现在每条独立证据都必须是首见，"不同题"的门槛自然就是"不同的首见题"。
       *
       * hintLevelUsed 读的是 attempt 列：提交时服务端已经按提示账本取过上限，
       * 不再是客户端自报的那个数。
       */
      const firstSeenHere = seenAt !== undefined && a.at === seenAt;
      const independent =
        index === 0 && firstSeenHere && a.correct && a.hintLevelUsed === 0 && !viewedBefore;
      if (independent) {
        s.independent++;
        const ats = independentAt.get(nodeId) ?? [];
        ats.push(a.at);
        independentAt.set(nodeId, ats);
        const qs = independentQuestions.get(nodeId) ?? new Set<string>();
        qs.add(a.questionId);
        independentQuestions.set(nodeId, qs);
        // 独立证据现在必然是首见；字段保留给既有调用方（家长报告等）读
        s.hasFirstSeen = true;
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
    /** 可选：测评里见过的题（真 Repo 有；测试替身可以不给） */
    assessmentSeenAt?(learnerId: string): Map<string, string>;
  },
  questions: { byId: Map<string, EvidenceQuestion> },
  learnerId: string,
): Map<string, EvidenceStats> {
  return evidenceStatsByNode(
    repo.attemptsForEvidence(learnerId),
    questions,
    repo.analysisViews(learnerId),
    repo.assessmentSeenAt?.(learnerId),
  );
}

/**
 * 一条**已经判定算数**的作答，把增益写进掌握度。
 *
 * /practice/submit、/practice/submit-photo 和家长裁决 /parent/verdict 共用这一段。
 * 早先裁决那条路自己写了一份：不打"看过解析"的折扣、次节点也按满额——
 * 同一个对勾，孩子自己答出来和家长裁出来，进掌握度的分量不一样。
 * "算不算数"仍由调用方判（各自的前置条件不同），但"算多少"只在这里。
 *
 * - 作答前看过这道题的解析：那一次答对是回忆，不是理解，增益打折（扣分照旧）
 * - 主节点满额；挂在这道题上的其它节点只沾一半（一题多节点不能都满分）
 * - hintLevelUsed 由调用方传入服务端值（attempt 列 / 提示账本上限），不信客户端
 */
export function applyCountedAttempt(
  repo: {
    attemptsForEvidence(learnerId: string): EvidenceAttempt[];
    analysisViews(learnerId: string): Map<string, string[]>;
    viewedAnalysisBefore(learnerId: string, questionId: string, at: string): boolean;
    getMastery(learnerId: string, nodeId: string): { p: number; evidenceN: number } | undefined;
    upsertMastery(row: { learnerId: string; nodeId: string; p: number; evidenceN: number; lastEvidenceAt: string | null }): void;
  },
  questions: { byId: Map<string, EvidenceQuestion> },
  input: {
    learnerId: string;
    questionId: string;
    nodeIds: string[];
    correct: boolean;
    hintLevelUsed: 0 | 1 | 2 | 3;
    /** 作答时刻：判"作答前看没看过解析"用它，而不是现在 */
    at: string;
  },
): { nodeId: string; p: number; band: MasteryBand }[] {
  const viewed = repo.viewedAnalysisBefore(input.learnerId, input.questionId, input.at);
  const stats = loadEvidenceStats(repo, questions, input.learnerId);
  const changes: { nodeId: string; p: number; band: MasteryBand }[] = [];
  input.nodeIds.forEach((nodeId, index) => {
    const current = repo.getMastery(input.learnerId, nodeId);
    const next = applyAttempt(
      current ? { p: current.p, evidenceN: current.evidenceN } : undefined,
      input.correct,
      input.hintLevelUsed,
      (viewed ? MASTERY_PARAMS.afterAnalysisGainFactor : 1) * (index === 0 ? 1 : 0.5),
    );
    repo.upsertMastery({
      learnerId: input.learnerId,
      nodeId,
      p: next.p,
      evidenceN: next.evidenceN,
      lastEvidenceAt: new Date().toISOString(),
    });
    changes.push({ nodeId, p: next.p, band: masteryBand(next.p, next.evidenceN, stats.get(nodeId)) });
  });
  return changes;
}

/** 这道节点现在该不该点亮（判据在 mastery.ts，这里只做转出，避免两处各写一份） */
export { litByEvidence };
export type { EvidenceStats, MasteryBand };
