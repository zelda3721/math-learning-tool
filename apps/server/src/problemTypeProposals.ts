import { matchProblemTypesOffline } from "@mathtutor/knowledge";
import type { EducationLevel, ProblemType, Question } from "@mathtutor/schema";

/**
 * 题型提案（纯函数，零模型）。
 *
 * 题型不是知识点：**知识点是大纲的骨架，题型是它在具体情境下的变体**。
 * 挂上题型，讲解才拿得到"这类题的本质是什么"——「年龄问题」的本质是
 * 「年龄差永远不变」，那正是这类题唯一要讲的东西；漏了就只剩"这道题这么算"。
 *
 * 但挂错比不挂更糟：它会让孩子学到另一类题的方法。所以这里只**提案**，
 * 附上分数、分差和命中的词，让人一眼看得出这匹马靠不靠得住：
 *
 * - 本学段：小学的题不可能是高中题型（关键词分不清"题里出现了三角形"
 *   和"这是一道解三角形的题"，学段能）
 * - 题型声明的知识点要和这道题挂的对得上（结构性的，撞不了运气）
 * - 高分且比第二名高不少才算高置信
 */

export type ProposalConfidence = "high" | "medium" | "low";

export interface ProblemTypeProposal {
  questionId: string;
  stem: string;
  level: EducationLevel;
  nodeIds: string[];
  proposed: string;
  proposedName: string;
  score: number;
  /** top1 ÷ top2；只有一个候选时记 999（没有第二名可比） */
  margin: number;
  /** 命中了哪几个关键词，界面直接显示——让人能判断靠不靠谱 */
  reasons: string[];
  alternatives: { id: string; name: string; score: number }[];
  confidence: ProposalConfidence;
}

const LEVEL_STAGE: Record<EducationLevel, string> = {
  elementary_lower: "primary",
  elementary_upper: "primary",
  middle: "junior",
  high: "senior",
  advanced: "university",
};

export function proposeProblemTypes(args: {
  questions: Question[];
  problemTypes: ProblemType[];
  includeLow?: boolean;
}): ProblemTypeProposal[] {
  const nameOf = new Map(args.problemTypes.map((t) => [t.id, t.name]));
  const out: ProblemTypeProposal[] = [];
  for (const item of args.questions) {
    if (item.problemTypeId) continue;
    const stage = LEVEL_STAGE[item.level];
    const candidates = args.problemTypes.filter(
      (t) => t.stage === stage && t.nodes.some((n) => item.nodeIds.includes(n)),
    );
    const matches = matchProblemTypesOffline(candidates, item.stem, 3);
    const top = matches[0];
    if (!top) continue;
    const second = matches[1]?.score ?? 0;
    const margin = second > 0 ? top.score / second : Number.POSITIVE_INFINITY;
    const confidence: ProposalConfidence =
      top.score >= 28 && margin >= 1.6 ? "high" : top.score >= 16 && margin >= 1.2 ? "medium" : "low";
    if (confidence === "low" && !args.includeLow) continue;
    out.push({
      questionId: item.id,
      stem: item.stem.slice(0, 80),
      level: item.level,
      nodeIds: item.nodeIds,
      proposed: top.id,
      proposedName: nameOf.get(top.id) ?? top.id,
      score: Math.round(top.score * 10) / 10,
      margin: Number.isFinite(margin) ? Math.round(margin * 100) / 100 : 999,
      reasons: top.reasons,
      alternatives: matches.slice(1).map((m) => ({
        id: m.id,
        name: nameOf.get(m.id) ?? m.id,
        score: Math.round(m.score * 10) / 10,
      })),
      confidence,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}
