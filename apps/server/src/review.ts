import { REVIEW_PARAMS, type Question } from "@mathtutor/schema";
import type { Repo, ReviewCardRow } from "./repo.js";
import type { QuestionStore } from "./questions.js";

/**
 * SM-2 简化变体（设计 §06）：间隔 [1,2,4,7,15,30] 天；
 * 答对进档（走完全部间隔 → mastered），答错回退 2 档、lapse+1、明天再来。
 * 宪法第 3 条：复习对象优先「同组/同题型换新题」，绝不重看原题答案。
 */

export function ensureReviewCard(repo: Repo, learnerId: string, questionId: string): void {
  repo.upsertReviewCard(learnerId, "question", questionId, nextDue(0));
}

function nextDue(stage: number): string {
  const days = REVIEW_PARAMS.intervalsDays[Math.min(stage, REVIEW_PARAMS.intervalsDays.length - 1)]!;
  return new Date(Date.now() + days * 86400_000).toISOString();
}

/** 复习作答后的推进；返回新状态描述（供 UI 展示） */
export function advanceReviewCard(
  repo: Repo,
  cardId: string,
  correct: boolean,
): { stage: number; mastered: boolean; nextReviewAt: string | null } {
  const card = repo.getReviewCard(cardId);
  if (!card) return { stage: 0, mastered: false, nextReviewAt: null };
  if (correct) {
    const stage = card.stage + 1;
    if (stage >= REVIEW_PARAMS.intervalsDays.length) {
      repo.masterReviewCard(cardId);
      return { stage, mastered: true, nextReviewAt: null };
    }
    const due = nextDue(stage);
    repo.updateReviewCard(cardId, { stage, nextReviewAt: due });
    return { stage, mastered: false, nextReviewAt: due };
  }
  const stage = Math.max(0, card.stage - REVIEW_PARAMS.wrongStagePenalty);
  const due = new Date(Date.now() + 86400_000).toISOString();
  repo.updateReviewCard(cardId, { stage, nextReviewAt: due, lapseCount: card.lapseCount + 1 });
  return { stage, mastered: false, nextReviewAt: due };
}

/**
 * 给到期复习卡挑「换题再练」的题：同 variantOf 组 > 同题型 > 同节点，
 * 都没有才退回原题（重做原题仍是检索练习，只是次优）。
 */
export function pickReviewQuestion(
  store: QuestionStore,
  card: ReviewCardRow,
  excludeIds: Set<string>,
): Question | undefined {
  if (card.targetKind === "node") {
    return (store.byNode.get(card.targetId) ?? []).find((q) => !excludeIds.has(q.id));
  }
  const original = store.byId.get(card.targetId);
  if (!original) return undefined;
  const group = original.variantOf ?? original.id;
  const inGroup = store.all.find(
    (q) => q.id !== original.id && !excludeIds.has(q.id) && (q.variantOf ?? q.id) === group,
  );
  if (inGroup) return inGroup;
  if (original.problemTypeId) {
    const sameType = store.all.find(
      (q) => q.id !== original.id && !excludeIds.has(q.id) && q.problemTypeId === original.problemTypeId,
    );
    if (sameType) return sameType;
  }
  for (const nodeId of original.nodeIds) {
    const sameNode = (store.byNode.get(nodeId) ?? []).find(
      (q) => q.id !== original.id && !excludeIds.has(q.id),
    );
    if (sameNode) return sameNode;
  }
  return excludeIds.has(original.id) ? undefined : original;
}
