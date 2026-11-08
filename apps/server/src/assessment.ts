import type { Question } from "@mathtutor/schema";
import type { QuestionStore } from "./questions.js";
import { practiceReady } from "./questions.js";
import type { Repo } from "./repo.js";

/**
 * 阶段测评：前测 / 后测 / 保持率（PLAN 第七部分那条"贯穿全程"的要求）。
 *
 * 为什么必须先有骨架：PLAN 写着"只有数据证明 AI 原生方式比单纯刷题更有效，才算完成"。
 * 没有前测，就没有"起点"；没有后测和保持率，就没有"学会了还是记住了"。
 *
 * 三条口径，都是为了别把测量变成装饰：
 * 1. **不碰掌握度**。测评单独记账（assessments / assessment_items），
 *    一旦往掌握度里写，测评就改变了它所测量的东西。
 * 2. **只用没做过的题**。做过的题怎么答都说明不了"能不能迁移"。
 *    题不够时如实标注 `reused`，不假装是新题。
 * 3. **不给提示**。测评里没有提示阶梯，答不出来就是答不出来。
 */

export type AssessmentKind = "pre" | "post" | "retention";

export const ASSESSMENT_KINDS: AssessmentKind[] = ["pre", "post", "retention"];

/** 后测在 7 天后，保持率在 28 天后——间隔太短测的是记忆，太长测的是遗忘 */
export const ASSESSMENT_SCHEDULE = { postAfterDays: 7, retentionAfterDays: 28 } as const;

export interface BuiltAssessment {
  scope: string[];
  questions: Question[];
  /** 题库里没那么多没做过的题，用了做过的题来凑（如实标注） */
  reused: boolean;
}

const DAY = 86_400_000;

/**
 * 挑题：沿 scope 的节点，一节点一道、优先没做过的题，先易后难。
 *
 * scope 缺省时用"孩子练过的节点"；一个都没练过（新孩子）就从本学段有题的节点里取——
 * 前测的意义本来就是"还不知道他会什么"。
 */
export function buildAssessment(
  store: QuestionStore,
  repo: Repo,
  learnerId: string,
  opts: { kind: AssessmentKind; scope?: string[]; count?: number },
): BuiltAssessment {
  const count = Math.min(Math.max(opts.count ?? 8, 4), 12);
  const attempted = repo.attemptedQuestionIds(learnerId);
  const mastery = repo.allMastery(learnerId).filter((m) => m.evidenceN > 0);

  const scope =
    opts.scope && opts.scope.length > 0
      ? opts.scope
      : mastery.length > 0
        ? mastery.sort((a, b) => a.p - b.p).slice(0, count).map((m) => m.nodeId)
        : [];

  const nodesWithQuestions =
    scope.length > 0
      ? scope
      : [...store.byNode.keys()].filter((id) => (store.byNode.get(id) ?? []).length > 0).slice(0, count);

  const usable = (q: Question) => practiceReady(q) && !store.figureMissing.has(q.id);

  const fresh: Question[] = [];
  const stale: Question[] = [];
  for (const nodeId of nodesWithQuestions) {
    const all = (store.byNode.get(nodeId) ?? []).filter(usable);
    const unseen = all.filter((q) => !attempted.has(q.id));
    const pick = (unseen.length ? unseen : all)[0];
    if (!pick) continue;
    (unseen.length ? fresh : stale).push(pick);
  }

  // 一节点一道不够就用剩下的题补满（同节点可以有第二道，但排在后面）
  const picked = [...fresh, ...stale].slice(0, count);
  const chosenIds = new Set(picked.map((q) => q.id));
  let reused = stale.some((q) => picked.some((p) => p.id === q.id));
  if (picked.length < count) {
    for (const nodeId of nodesWithQuestions) {
      for (const q of store.byNode.get(nodeId) ?? []) {
        if (picked.length >= count) break;
        if (!usable(q) || chosenIds.has(q.id)) continue;
        picked.push(q);
        chosenIds.add(q.id);
        if (attempted.has(q.id)) reused = true;
      }
    }
  }

  return { scope: nodesWithQuestions.filter((id) => picked.some((q) => q.nodeIds.includes(id))), questions: picked, reused };
}

export interface AssessmentSuggestion {
  kind: AssessmentKind;
  /** 为什么现在该做这一份 */
  why: string;
  /** 还没到时间时给一句"什么时候再来" */
  dueAt?: string;
}

/**
 * 下一份测什么：没有前测先做前测；做过前测满 7 天做后测；做过后测满 28 天做保持率。
 * 同一档只做一次——重复做会把"测评"变成"刷测评"，数字立刻失真。
 */
export function nextAssessment(
  repo: Repo,
  learnerId: string,
  now = new Date(),
): AssessmentSuggestion | null {
  const list = repo.listAssessments(learnerId, 50).filter((a) => a.finishedAt);
  const latest = (kind: AssessmentKind) =>
    list
      .filter((a) => a.kind === kind)
      .sort((a, b) => (a.finishedAt! < b.finishedAt! ? 1 : -1))[0];

  const pre = latest("pre");
  if (!pre) {
    return { kind: "pre", why: "先做一次前测：之后才说得清这段时间学到了什么。" };
  }
  const post = latest("post");
  const days = (from: string) => (now.getTime() - Date.parse(from)) / DAY;

  if (!post) {
    const due = days(pre.finishedAt!) >= ASSESSMENT_SCHEDULE.postAfterDays;
    if (due) return { kind: "post", why: "离前测已经过去一周，做一次后测看看学到哪儿了。" };
    return {
      kind: "post",
      why: "后测安排在前测一周后。",
      dueAt: new Date(Date.parse(pre.finishedAt!) + ASSESSMENT_SCHEDULE.postAfterDays * DAY).toISOString(),
    };
  }
  const retention = latest("retention");
  if (!retention) {
    const due = days(post.finishedAt!) >= ASSESSMENT_SCHEDULE.retentionAfterDays;
    if (due) return { kind: "retention", why: "离后测过去四周了，看看当时会的现在还记不记得。" };
    return {
      kind: "retention",
      why: "保持率检查安排在后测四周后。",
      dueAt: new Date(Date.parse(post.finishedAt!) + ASSESSMENT_SCHEDULE.retentionAfterDays * DAY).toISOString(),
    };
  }
  return null;
}

export interface AssessmentResult {
  id: string;
  kind: AssessmentKind;
  answered: number;
  total: number;
  correct: number;
  /** 0..1；一道没答返回 null（不拿 0 冒充"全错"） */
  rate: number | null;
  byNode: { nodeId: string; correct: number; total: number }[];
  items: { questionId: string; correct: boolean | null; reference: string }[];
}

/** 交卷统计（确定性；不调模型） */
export function summarizeAssessment(
  assessment: { id: string; kind: string; scope: string[] },
  items: { questionId: string; correct: boolean | null }[],
  referenceOf: (questionId: string) => string,
  nodeIdsOf: (questionId: string) => string[],
): AssessmentResult {
  const answered = items.filter((i) => i.correct !== null);
  const correct = answered.filter((i) => i.correct).length;
  const byNode = new Map<string, { correct: number; total: number }>();
  for (const item of answered) {
    for (const nodeId of nodeIdsOf(item.questionId)) {
      if (!assessment.scope.includes(nodeId)) continue;
      const cur = byNode.get(nodeId) ?? { correct: 0, total: 0 };
      cur.total += 1;
      if (item.correct) cur.correct += 1;
      byNode.set(nodeId, cur);
    }
  }
  return {
    id: assessment.id,
    kind: assessment.kind as AssessmentKind,
    answered: answered.length,
    total: items.length,
    correct,
    rate: answered.length > 0 ? correct / answered.length : null,
    byNode: [...byNode.entries()].map(([nodeId, v]) => ({ nodeId, ...v })),
    items: items.map((i) => ({ questionId: i.questionId, correct: i.correct, reference: referenceOf(i.questionId) })),
  };
}

/**
 * 前测 → 后测 → 保持率：同一批节点上的对比。
 *
 * 只比**两次都覆盖到的节点**：后测换了题，没覆盖到的节点谈不上变化。
 */
export function compareAssessments(
  before: { kind: string; byNode: { nodeId: string; correct: number; total: number }[] },
  after: { kind: string; byNode: { nodeId: string; correct: number; total: number }[] },
): {
  before: string;
  after: string;
  nodes: { nodeId: string; beforeRate: number; afterRate: number; delta: number }[];
  overall: { beforeRate: number | null; afterRate: number | null };
} {
  const rateOf = (v: { correct: number; total: number }) => (v.total > 0 ? v.correct / v.total : 0);
  const beforeMap = new Map(before.byNode.map((n) => [n.nodeId, n]));
  const nodes = after.byNode
    .filter((n) => beforeMap.has(n.nodeId))
    .map((n) => {
      const b = beforeMap.get(n.nodeId)!;
      return { nodeId: n.nodeId, beforeRate: rateOf(b), afterRate: rateOf(n), delta: rateOf(n) - rateOf(b) };
    });
  const sum = (list: { correct: number; total: number }[]) => {
    const total = list.reduce((n, v) => n + v.total, 0);
    return total > 0 ? list.reduce((n, v) => n + v.correct, 0) / total : null;
  };
  return {
    before: before.kind,
    after: after.kind,
    nodes,
    overall: {
      beforeRate: sum(before.byNode.filter((n) => after.byNode.some((a) => a.nodeId === n.nodeId))),
      afterRate: sum(after.byNode.filter((n) => beforeMap.has(n.nodeId))),
    },
  };
}
