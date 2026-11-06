import type { GraphIndex } from "./graph.js";

/**
 * 课程计划：把家长确认过的（章节 → 节点）对齐结果，按**先修关系**排成上课顺序。
 *
 * 为什么必须重排而不是照书上的顺序：教材的顺序是"编写顺序"，不是"可学顺序"。
 * 同一本书里，某章会用到还没讲的另一章的概念——照书排，孩子会在缺前置的状态下上课，
 * 而那种课上得越认真越挫败。
 *
 * 三条约束：
 * - **只在不违反先修的前提下调整**：图谱里有前置关系的，前置排在前面；
 * - **没有关系的一律保持原书顺序**：教材作者比我们更懂这本书的叙事顺序，
 *   在信息不足时不要自作主张；
 * - **有环就退回原序**：图谱里出现环本身就是数据问题，这时任何"聪明"的排序
 *   都比原序更不可信。
 */

export interface ConfirmedLink {
  chapterTitle: string;
  nodeId: string;
}

export interface PlannedLesson {
  /** 第几课（1 起），给家长看 */
  order: number;
  chapterTitle: string;
  nodeId: string;
  nodeName: string;
  /** 重排理由：被前置关系推后的，写明被谁推后——否则家长会以为顺序错了 */
  movedBecauseOf: string[];
}

export interface CurriculumPlan {
  lessons: PlannedLesson[];
  /** 图谱里有环，退回了原书顺序 */
  cycleDetected: boolean;
}

/**
 * 排课。稳定拓扑：同一层内保持原书顺序。
 *
 * 用 Kahn 算法而不是"DFS 再反转"，因为前者天然产出**层内稳定**的顺序——
 * 而稳定性在这里就是"尽量不影响原书顺序"这条约束。
 */
export function planCurriculum(
  index: GraphIndex,
  links: readonly ConfirmedLink[],
): CurriculumPlan {
  const positionOf = new Map<string, number>();
  links.forEach((l, i) => {
    // 同一节点被确认两次：保留第一次出现的位置，后面的自然成为重复项
    if (!positionOf.has(l.nodeId)) positionOf.set(l.nodeId, i);
  });

  const ids = new Set(positionOf.keys());
  // 前置边只在本批确认的节点之间起作用：把未确认的节点排进来，等于替家长做了决定
  const prerequisitesOf = (id: string): string[] =>
    (index.getNode(id)?.prerequisites ?? []).filter((p) => ids.has(p));

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const id of ids) {
    for (const p of prerequisitesOf(id)) {
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      dependents.get(p)!.push(id);
    }
  }

  const byPosition = [...ids].sort((a, b) => (positionOf.get(a) ?? 0) - (positionOf.get(b) ?? 0));
  const queue = byPosition.filter((id) => indegree.get(id) === 0);
  const ordered: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, left);
      if (left === 0) {
        // 按原书位置插入，保持层内稳定
        const at = queue.findIndex((q) => (positionOf.get(q) ?? 0) > (positionOf.get(next) ?? 0));
        if (at < 0) queue.push(next);
        else queue.splice(at, 0, next);
      }
    }
  }

  const cycleDetected = ordered.length !== ids.size;
  // 有环：退回原书顺序，并把环里的节点也带上（少讲几课比讲错顺序更糟）
  const finalOrder = cycleDetected ? byPosition : ordered;

  const lessons = finalOrder.map((nodeId, i) => {
    const link = links[positionOf.get(nodeId) ?? 0]!;
    const moved: string[] = [];
    const originalIndex = positionOf.get(nodeId) ?? 0;
    if (i !== originalIndex) {
      for (const p of prerequisitesOf(nodeId)) {
        const prereqName = index.getNode(p)?.name ?? p;
        moved.push(`${prereqName} 是它的前置，所以排在前面`);
      }
    }
    return {
      order: i + 1,
      chapterTitle: link.chapterTitle,
      nodeId,
      nodeName: index.getNode(nodeId)?.name ?? nodeId,
      movedBecauseOf: moved,
    };
  });

  return { lessons, cycleDetected };
}
