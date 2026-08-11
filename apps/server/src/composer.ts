import type { EducationLevel, Question } from "@mathtutor/schema";
import { STAGE_OF } from "@mathtutor/schema";
import type { GraphIndex } from "@mathtutor/knowledge";
import type { Repo } from "./repo.js";
import { practiceReady, type QuestionStore } from "./questions.js";
import { effectiveP, masteryBand } from "./mastery.js";
import { pickReviewQuestion } from "./review.js";

const LEVEL_ORDER: EducationLevel[] = [
  "elementary_lower",
  "elementary_upper",
  "middle",
  "high",
  "advanced",
];

export interface ComposedQuestion {
  question: Question;
  slot: "review" | "queue" | "weak" | "new" | "challenge";
  queueItemId?: string;
  /** SM-2 复习卡：submit 带回以推进间隔 */
  reviewCardId?: string;
}

/**
 * 最小组卷器（P1a）：固定优先级 队列 > 弱点节点 > 新题，外加 1 道挑战题。
 * P2 起探针写入队列；P3 升级为完整策略（SM-2 到期复习优先）。零 LLM。
 */
export function composeToday(
  store: QuestionStore,
  index: GraphIndex,
  repo: Repo,
  learnerId: string,
  opts: { count?: number; challenge?: boolean } = {},
): ComposedQuestion[] {
  const learner = repo.getLearner(learnerId);
  if (!learner) return [];
  const target = Math.min(Math.max(opts.count ?? 6, 3), 8);
  const excluded = repo.recentlyCorrectQuestionIds(learnerId, 3);
  const picked: ComposedQuestion[] = [];
  const pickedIds = new Set<string>();

  const take = (
    q: Question | undefined,
    slot: ComposedQuestion["slot"],
    queueItemId?: string,
    reviewCardId?: string,
  ) => {
    // 唯一一道闸：五条选题路径都从这里过。
    // 起初我在弱点/新题两处各加了一次判断，挑战题那条就漏了——
    // 同一条规则写在几个地方，早晚会漏掉一处，而漏掉的表现是
    // "孩子拿到一道答案是猜的题"，从结果上完全看不出来。
    if (!q || pickedIds.has(q.id) || excluded.has(q.id) || !practiceReady(q)) return false;
    picked.push({ question: q, slot, queueItemId, reviewCardId });
    pickedIds.add(q.id);
    return true;
  };

  // 1) 到期复习（SM-2，宪法第 3 条：换题再练——原题排除后由 pickReviewQuestion 找同组/同型新题）
  for (const card of repo.dueReviewCards(learnerId, target)) {
    if (picked.length >= target) break;
    const q = pickReviewQuestion(store, card, new Set([...pickedIds, ...excluded]));
    take(q, "review", undefined, card.id);
  }

  // 2) 探针队列（P2 诊断排入；作答结果回填归因证据）
  for (const item of repo.dueQueueQuestionIds(learnerId, target)) {
    if (picked.length >= target) break;
    take(store.byId.get(item.questionId), "queue", item.id);
  }

  // 3) 弱点节点：有证据且有效掌握度最低的节点，取其未做对的题
  const mastery = repo.allMastery(learnerId);
  const weakNodes = mastery
    .map((m) => ({ nodeId: m.nodeId, p: effectiveP(m), evidenceN: m.evidenceN }))
    .filter((m) => m.evidenceN > 0 && masteryBand(m.p, m.evidenceN) !== "lit")
    .sort((a, b) => a.p - b.p);
  // 难度 ≥4 的题保留为挑战池，不进核心槽（否则挑战题会被弱点/新题槽提前吃掉）
  const isChallengePool = (q: Question) => q.difficulty >= 4;

  for (const weak of weakNodes) {
    if (picked.length >= target) break;
    for (const q of store.byNode.get(weak.nodeId) ?? []) {
      if (picked.length >= target) break;
      if (isChallengePool(q)) continue;
      if (q.level === learner.level || sameStage(q.level, learner.level)) take(q, "weak");
    }
  }

  // 4) 新题：无任何证据的节点，按图谱学段内顺序
  const evidenced = new Set(mastery.filter((m) => m.evidenceN > 0).map((m) => m.nodeId));
  const orderedNodes = [...index.graph.nodes].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.lane ?? 0) - (b.lane ?? 0),
  );
  for (const node of orderedNodes) {
    if (picked.length >= target) break;
    if (evidenced.has(node.id)) continue;
    for (const q of store.byNode.get(node.id) ?? []) {
      if (picked.length >= target) break;
      if (isChallengePool(q)) continue;
      if (q.level === learner.level || sameStage(q.level, learner.level)) take(q, "new");
    }
  }

  // 5) 挑战题（合意难度）：高一档难度或下一年级段，1 道
  if (opts.challenge !== false) {
    const nextLevel = LEVEL_ORDER[LEVEL_ORDER.indexOf(learner.level) + 1];
    const challenge =
      store.all.find(
        (q) => q.level === learner.level && q.difficulty >= 4 && !pickedIds.has(q.id) && !excluded.has(q.id),
      ) ??
      (nextLevel
        ? store.all.find(
            (q) => q.level === nextLevel && q.difficulty <= 2 && !pickedIds.has(q.id) && !excluded.has(q.id),
          )
        : undefined);
    take(challenge, "challenge");
  }

  return picked;
}

function sameStage(a: EducationLevel, b: EducationLevel): boolean {
  return STAGE_OF[a] === STAGE_OF[b];
}
