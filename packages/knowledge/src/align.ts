import { matchOffline } from "./locator.js";
import type { GraphIndex } from "./graph.js";

/**
 * 教材对齐：把一章内容映射到图谱节点——**只出候选，绝不写入**。
 *
 * PLAN 里这一条是硬约束：教材编译产出的知识点要经家长确认才进图谱，
 * 候选节点绝不直接写。理由不是谨慎过头：
 *
 * - 图谱是掌握度、诊断、复习、讲解的共同底稿。往里写一个错节点，
 *   错的不只是那一行数据，而是**所有引用它的地方**，而且没有任何一处会报错；
 * - 对齐是相似度判断，不是事实判断。「分数的意义」与「分数的基本性质」
 *   在关键词层面几乎一样，在课标里是两节——模型分不出，人一眼就分得出。
 *
 * 所以本模块的产物是一个**待确认清单**，而不是一批节点。
 */

export interface AlignmentCandidate {
  nodeId: string;
  nodeName: string;
  score: number;
  /** 为什么它被选中（关键词/别名命中），家长要能看懂才能判断 */
  reasons: string[];
}

export type AlignmentStatus = "pending" | "confirmed" | "rejected";

export interface AlignmentItem {
  /** 教材里的章节标题 */
  chapterTitle: string;
  candidates: AlignmentCandidate[];
  status: AlignmentStatus;
  /** 家长确认后选定的节点；rejected 或 pending 时为 null */
  chosen: string | null;
}

export interface AlignmentProposal {
  items: AlignmentItem[];
  /** 供界面展示的一句话：有多少章待确认 */
  pendingCount: number;
}

/**
 * 为一章内容产生候选。**没有候选也是一种诚实的结果**：
 * 强行给一个低分节点，家长就得逐个否决，比空白更费神。
 */
export function proposeChapter(
  index: GraphIndex,
  chapterTitle: string,
  text: string,
  topN = 3,
): AlignmentItem {
  const haystack = `${chapterTitle}\n${text}`.slice(0, 4000);
  const matches = matchOffline(index, haystack, topN);
  return {
    chapterTitle,
    candidates: matches.map((m) => ({
      nodeId: m.id,
      nodeName: index.getNode(m.id)?.name ?? m.id,
      score: m.score,
      reasons: m.reasons ?? [],
    })),
    status: "pending",
    chosen: null,
  };
}

export function proposeAlignment(
  index: GraphIndex,
  chapters: readonly { title: string; text: string }[],
): AlignmentProposal {
  const items = chapters.map((c) => proposeChapter(index, c.title, c.text));
  return { items, pendingCount: items.length };
}

/**
 * 把家长的裁决应用到清单上。返回**新**清单，不改原对象——
 * 提案要能被原样留存下来给家长复核，改掉就查不到"当初给了什么候选"。
 */
export function decide(
  proposal: AlignmentProposal,
  chapterTitle: string,
  decision: { status: "confirmed"; nodeId: string } | { status: "rejected" },
): AlignmentProposal {
  const items = proposal.items.map((item) => {
    if (item.chapterTitle !== chapterTitle) return item;
    if (decision.status === "rejected") {
      return { ...item, status: "rejected" as const, chosen: null };
    }
    // 只接受候选里真的有的那个：家长手抄/前端传错都不该让图谱里多出一个没被评估过的节点
    const exists = item.candidates.some((c) => c.nodeId === decision.nodeId);
    if (!exists) return item;
    return { ...item, status: "confirmed" as const, chosen: decision.nodeId };
  });
  return { items, pendingCount: items.filter((i) => i.status === "pending").length };
}

/**
 * 取出可以写进图谱的对齐结果。
 *
 * **只有 confirmed 的条目会出现在这里**——这是本模块唯一的出口，
 * 也是"绝不直接写入"这条约束落地的地方：没有家长裁决，
 * 这个函数就永远返回空数组。
 */
export function confirmedLinks(proposal: AlignmentProposal): { chapterTitle: string; nodeId: string }[] {
  return proposal.items
    .filter((i) => i.status === "confirmed" && i.chosen !== null)
    .map((i) => ({ chapterTitle: i.chapterTitle, nodeId: i.chosen as string }));
}
