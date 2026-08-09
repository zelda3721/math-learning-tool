import type { EducationLevel, Question } from "@mathtutor/schema";
import { STAGE_OF } from "@mathtutor/schema";
import type { GraphIndex } from "@mathtutor/knowledge";
import type { Repo } from "./repo.js";
import type { QuestionStore } from "./questions.js";
import { effectiveP, masteryBand } from "./mastery.js";

const LEVEL_ORDER: EducationLevel[] = [
  "elementary_lower",
  "elementary_upper",
  "middle",
  "high",
  "advanced",
];

export interface ComposedQuestion {
  question: Question;
  slot: "queue" | "weak" | "new" | "challenge";
  queueItemId?: string;
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

  const take = (q: Question | undefined, slot: ComposedQuestion["slot"], queueItemId?: string) => {
    if (!q || pickedIds.has(q.id) || excluded.has(q.id)) return false;
    picked.push({ question: q, slot, queueItemId });
    pickedIds.add(q.id);
    return true;
  };

  // 1) 队列（探针/复习）
  for (const item of repo.dueQueueQuestionIds(learnerId, target)) {
    if (picked.length >= target) break;
    take(store.byId.get(item.questionId), "queue", item.id);
  }

  // 2) 弱点节点：有证据且有效掌握度最低的节点，取其未做对的题
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

  // 3) 新题：无任何证据的节点，按图谱学段内顺序
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

  // 4) 挑战题（合意难度）：高一档难度或下一年级段，1 道
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
