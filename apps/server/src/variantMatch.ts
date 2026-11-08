import type { Question } from "@mathtutor/schema";
import { normalizeText } from "@mathtutor/subject-math";

/**
 * 「同题型换题」的确定性判定（P2）。
 *
 * 实测题库 288 道里 `variantOf` 一个都没有、`problemTypeId` 只有 5 道——
 * 也就是说"变式门"和"复习=换题再练"这两条宪法级承诺，在数据上根本没有原料。
 * 光靠等人工给 288 道题打标不现实，而模型打标又会把题型标歪（那比不标更糟）。
 *
 * 这里换一个**不用标注**也能判的口径：把题干里的数字换成占位符，剩下的骨架
 * 就是这道题的"模板"。
 *
 *   小明有 26 个苹果，吃掉 3 个，还剩几个？
 *   小明有 40 个苹果，吃掉 8 个，还剩几个？   ← 同一个骨架
 *
 * 同一个骨架意味着"换个数字还会不会"这件事真的被考到了——这正是变式门
 * 想验证的东西。骨架不同但措辞高度重合的（描述性文字换了情境），按相似度次选。
 */

/** 数字（含小数、百分号、分数）统一换成 #，去掉空白与标点后的骨架 */
export function stemSkeleton(stem: string): string {
  return normalizeText(stem)
    .replace(/\d+(?:\.\d+)?%?/g, "#")
    .replace(/#+/g, "#")
    .replace(/[，。！？、,.!?~～…—\-"'“”‘’()（）:：;；]/g, "")
    .replace(/\s+/g, "");
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

/** 两段骨架的二元组重合度（0..1）：0.55 以上才算"同一类题的措辞" */
export function skeletonSimilarity(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared += 1;
  return shared / Math.min(ga.size, gb.size);
}

export type VariantQuality = "same-skeleton" | "same-type" | "similar" | "same-node";

export interface VariantCandidate {
  question: Question;
  quality: VariantQuality;
  similarity: number;
}

/**
 * 给一道原题排候选变式（越好越靠前）。
 *
 * `eligible` 由调用方给（可用性、是否最近做对过、难度差）——这里只管"像不像"。
 */
export function rankVariantCandidates(
  original: Question,
  candidates: Question[],
  eligible: (q: Question) => boolean = () => true,
): VariantCandidate[] {
  const base = stemSkeleton(original.stem);
  const out: VariantCandidate[] = [];
  for (const q of candidates) {
    if (q.id === original.id || !eligible(q)) continue;
    const sim = skeletonSimilarity(base, stemSkeleton(q.stem));
    let quality: VariantQuality | undefined;
    if (sim >= 0.92) quality = "same-skeleton";
    else if (original.problemTypeId && q.problemTypeId === original.problemTypeId) quality = "same-type";
    else if (sim >= 0.55) quality = "similar";
    else if (q.nodeIds.some((n) => original.nodeIds.includes(n))) quality = "same-node";
    if (!quality) continue;
    out.push({ question: q, quality, similarity: Math.round(sim * 100) / 100 });
  }
  const rank: Record<VariantQuality, number> = { "same-skeleton": 0, "same-type": 1, similar: 2, "same-node": 3 };
  return out.sort(
    (a, b) =>
      rank[a.quality] - rank[b.quality] ||
      b.similarity - a.similarity ||
      Math.abs(a.question.difficulty - original.difficulty) - Math.abs(b.question.difficulty - original.difficulty),
  );
}

/** 最合适的一道变式；没有就返回 undefined（交给调用方降级） */
export function findVariantQuestion(
  original: Question,
  candidates: Question[],
  eligible?: (q: Question) => boolean,
): Question | undefined {
  return rankVariantCandidates(original, candidates, eligible)[0]?.question;
}
