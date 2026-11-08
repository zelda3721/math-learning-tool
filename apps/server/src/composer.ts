import type { EducationLevel, Question } from "@mathtutor/schema";
import { STAGE_OF } from "@mathtutor/schema";
import type { GraphIndex } from "@mathtutor/knowledge";
import type { Repo } from "./repo.js";
import { isEnglishNodeId, practiceReady, type QuestionStore } from "./questions.js";
import { effectiveP, masteryBand } from "./mastery.js";
import { loadEvidenceStats } from "./evidence.js";
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
  /**
   * 槽位标签描述的是**孩子和这道题的关系**，规则梳理如下：
   *
   *   复习     到期复习卡（错过的知识点按 SM-2 回来，换题再练）
   *   探针     诊断流程排进来的确认题
   *   新题     **这道题没做过**——哪怕它的知识点摸过。选题仍按"最弱的
   *            知识点先练"排序，但一道没见过的题不该顶着弱点/巩固的帽子
   *   弱点     做过、错过，且知识点掌握度低（dim，p<0.4）——真补弱
   *   巩固     做过这道题，知识点摸过但还没点亮——再练一遍加固
   *   挑战     难度拔高（难度≥4 或下一学段）
   *
   * 走过的弯路都在"把知识点的状态贴到题上"：
   * 第一版把"有证据且未点亮"一律标弱点（孩子做对一次反而挨红标）；
   * 第二版分了弱点/巩固，但一道**从没做过**的题还是会因为知识点摸过
   * 而顶着巩固——对孩子来说那就是道新题。
   * 现在弱点/巩固只出现在**重做过的题**上。
   */
  slot: "review" | "queue" | "weak" | "consolidate" | "new" | "challenge" | "placement";
  queueItemId?: string;
  /** SM-2 复习卡：submit 带回以推进间隔 */
  reviewCardId?: string;
}

/**
 * 最小组卷器（P1a）：固定优先级 队列 > 弱点节点 > 新题，外加 1 道挑战题。
 * P2 起探针写入队列；P3 升级为完整策略（SM-2 到期复习优先）。零 LLM。
 */
/** 图谱学段从低到高：跨学段排序要用它，不能拿各 strand 自己的 order 硬比 */
const STAGE_RANK: Record<string, number> = { primary: 0, junior: 1, senior: 2, university: 3 };

/**
 * 先修深度：没有前置的节点是 0，其余是 1 + 前置的最大深度。
 *
 * 为什么不能用 `order`：order 是**各 strand 自己**的编号，几何的第 3 个节点
 * 与代数第 3 个节点没有先后关系。拿它全局排序的结果，是新孩子第二组就会出现
 * 一元一次方程排在「100 以内的数」之前。
 */
export function prerequisiteDepth(index: GraphIndex): Map<string, number> {
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const calc = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // 环由 lint 拦；这里只求不炸
    visiting.add(id);
    const pres = index.getNode(id)?.prerequisites ?? [];
    const depth = pres.length ? 1 + Math.max(...pres.map(calc)) : 0;
    visiting.delete(id);
    memo.set(id, depth);
    return depth;
  };
  return new Map(index.graph.nodes.map((n) => [n.id, calc(n.id)]));
}

/** 节点属于哪一科：subject 字段为准，旧数据用 id 前缀兜底 */
function subjectOfNode(index: GraphIndex, nodeId: string): string {
  const node = index.getNode(nodeId) as { subject?: string } | undefined;
  if (node?.subject) return node.subject;
  return isEnglishNodeId(nodeId) ? "english" : "math";
}

export function composeToday(
  store: QuestionStore,
  index: GraphIndex,
  repo: Repo,
  learnerId: string,
  opts: { count?: number; challenge?: boolean; subject?: string } = {},
): ComposedQuestion[] {
  const subject = opts.subject ?? "math";
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
    // 这一科里一道题都挂不上（纯英语题不该出现在数学练习里）
    if (!q.nodeIds.some((id) => subjectOfNode(index, id) === subject)) return false;
    // 原图丢了的题不进组卷：读不懂题比不做更伤（名单见 store.figureMissing）
    if (store.figureMissing.has(q.id)) return false;
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
  const evidence = loadEvidenceStats(repo, store, learnerId);
  const weakNodes = mastery
    .map((m) => ({ nodeId: m.nodeId, p: effectiveP(m), evidenceN: m.evidenceN }))
    .filter((m) => m.evidenceN > 0 && masteryBand(m.p, m.evidenceN, evidence.get(m.nodeId)) !== "lit")
    .sort((a, b) => a.p - b.p);
  // 难度 ≥4 的题保留为挑战池，不进核心槽（否则挑战题会被弱点/新题槽提前吃掉）
  const isChallengePool = (q: Question) => q.difficulty >= 4;

  const attempted = repo.attemptedQuestionIds(learnerId);
  for (const weak of weakNodes) {
    if (picked.length >= target) break;
    // 选题顺序不变（最弱的知识点先练）；标签看孩子和这道题的关系：
    // 没做过的题就是新题，弱点/巩固只贴在重做的题上
    const band = masteryBand(weak.p, weak.evidenceN, evidence.get(weak.nodeId)) === "dim" ? "weak" : "consolidate";
    for (const q of store.byNode.get(weak.nodeId) ?? []) {
      if (picked.length >= target) break;
      if (isChallengePool(q)) continue;
      const slot = attempted.has(q.id) ? band : "new";
      if (q.level === learner.level || sameStage(q.level, learner.level)) take(q, slot);
    }
  }

  /*
   * 4) 新题：无任何证据的节点，按**学段 → 先修深度 → 主线内顺序**排。
   *
   * 原来的排序只比各 strand 自己的 order，于是几何的第 3 个节点与代数第 3 个节点
   * 平起平坐——新孩子的第二组就会出现一元一次方程排在「100 以内的数」之前。
   * 学段与先修深度是跨主线可比的，order 只在同一主线内有意义。
   */
  const evidenced = new Set(mastery.filter((m) => m.evidenceN > 0).map((m) => m.nodeId));
  const depth = prerequisiteDepth(index);
  const learnerStageRank = STAGE_RANK[STAGE_OF[learner.level]] ?? 0;
  const orderedNodes = [...index.graph.nodes]
    .filter((n) => subjectOfNode(index, n.id) === subject)
    // 不给孩子还没到的学段：小学孩子的练习里不该出现初中节点
    .filter((n) => (STAGE_RANK[n.stage] ?? 0) <= learnerStageRank)
    .sort(
      (a, b) =>
        (STAGE_RANK[a.stage] ?? 0) - (STAGE_RANK[b.stage] ?? 0) ||
        (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) ||
        (a.order ?? 0) - (b.order ?? 0) ||
        (a.lane ?? 0) - (b.lane ?? 0),
    );

  /*
   * 摸底组（新孩子、一点证据都没有）：沿先修顺序、每个知识点一道、先把各条主线
   * 各摸一道。早先新孩子第一组是 6 道同一节点的同类题——不知道他会不会，
   * 却把整组都压在最小的那个知识点上。
   */
  const placement = mastery.length === 0 && picked.length === 0;
  const eligible = (nodeId: string) =>
    (store.byNode.get(nodeId) ?? []).find(
      (q) =>
        practiceReady(q) &&
        !store.figureMissing.has(q.id) &&
        !isChallengePool(q) &&
        (q.level === learner.level || sameStage(q.level, learner.level)) &&
        !pickedIds.has(q.id) &&
        !excluded.has(q.id),
    );

  if (placement) {
    const strands = new Set<string>();
    for (const node of orderedNodes) {
      if (picked.length >= target) break;
      const strand = `${node.stage}:${node.strand}`;
      if (strands.has(strand)) continue;
      const q = eligible(node.id);
      if (q && take(q, "placement")) strands.add(strand);
    }
    // 主线数不够时再按顺序补满（同一条主线最多补到够为止）
    for (const node of orderedNodes) {
      if (picked.length >= target) break;
      take(eligible(node.id), "placement");
    }
    return picked;
  }

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
