import type { KnowledgeNode, ProblemType } from "@mathtutor/schema";
import type { GraphIndex } from "./graph.js";

/** 定位命中（离线启发式或 LLM 经程序校验后的结果） */
export interface LocatorMatch {
  id: string;
  score: number;
  reasons: string[];
}

const STOP = new Set(["的", "了", "是", "在", "和", "与", "有", "个", "及", "中", "对", "为"]);

/** 中文字符二元组（模糊匹配基元） */
function bigrams(text: string): string[] {
  const clean = text.replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}

function nodeTerms(n: KnowledgeNode): string[] {
  const terms = new Set<string>();
  terms.add(n.name);
  for (const k of n.keywords ?? []) terms.add(k);
  if (n.nameEn) terms.add(n.nameEn.toLowerCase());
  return [...terms];
}

/** 离线匹配知识点：零依赖启发式，永远可用（LLM 定位失败时的兜底） */
export function matchOffline(index: GraphIndex, rawInput: string, topN = 6): LocatorMatch[] {
  const input = rawInput.trim();
  if (input.length < 1) return [];
  const inputLower = input.toLowerCase();
  const inputBigrams = new Set(bigrams(input));

  const scored = index.graph.nodes.map((n) => {
    let score = 0;
    const reasons: string[] = [];

    for (const term of nodeTerms(n)) {
      if (term.length >= 2 && (input.includes(term) || inputLower.includes(term.toLowerCase()))) {
        score += term.length * 6;
        reasons.push(term);
      }
    }

    const nameGrams = bigrams(n.name);
    let overlap = 0;
    for (const g of nameGrams) if (inputBigrams.has(g)) overlap++;
    if (overlap > 0) {
      score += overlap * 3;
      if (!reasons.length) reasons.push(`「${n.name}」相关`);
    }

    const surfaceGrams = bigrams(n.summary + (n.whatIsIt ?? ""));
    let weak = 0;
    const seen = new Set<string>();
    for (const g of surfaceGrams) {
      if (seen.has(g)) continue;
      seen.add(g);
      if (g.length === 2 && !STOP.has(g[0]!) && inputBigrams.has(g)) weak++;
    }
    score += Math.min(weak, 8) * 0.6;

    return { id: n.id, score, reasons: [...new Set(reasons)] };
  });

  return scored
    .filter((m) => m.score > 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

/** 离线匹配题型：名称/关键词命中权重高（「鸡兔同笼」这类名字很独特） */
/**
 * 题型判定的分数下限。
 *
 * 实测 55 条真实奥数题干（三年级讲义）：靠谱的匹配落在 32~60 分，
 * 硬凑出来的原本全部聚在 8 分——几道计数题被判成"盈亏问题"，
 * 只因题干里有「多少」而该题型把「多」「少」列成了关键词。
 * 阈值 24 时给出题型 17/55、疑似错配 1；再低就开始成片误判。
 * 一个错的题型比没有题型糟得多——它会带偏变式生成与错因归因。
 * 宁可说"没认出来"，也不要给一个看着笃定的错答案。
 */
export const PROBLEM_TYPE_FLOOR = 24;

export function matchProblemTypesOffline(
  problemTypes: ProblemType[],
  rawInput: string,
  topN = 3,
): LocatorMatch[] {
  const input = rawInput.trim();
  if (!input) return [];
  const grams = new Set(bigrams(input));
  const scored = problemTypes.map((p) => {
    let score = 0;
    const reasons: string[] = [];
    for (const k of [p.name, ...(p.keywords ?? [])]) {
      if (k.length >= 1 && input.includes(k)) {
        // 单字是弱证据：中文里「多」「少」「和」这类字几乎每道题都有
        // （"共有多少个平行四边形"里就有 多 和 少），
        // 按原来每字 4 分，两个字就够把一道计数题判成盈亏问题。
        // 内容名词（鸡/兔/岁/船/草）仍然有用，但必须靠数量堆够，不能一两个就定案。
        score += k.length >= 2 ? k.length * 7 : 1;
        reasons.push(k);
      }
    }
    let overlap = 0;
    for (const g of bigrams(p.name)) if (grams.has(g)) overlap++;
    score += overlap * 4;
    return { id: p.id, score, reasons: [...new Set(reasons)].slice(0, 3) };
  });
  return scored
    .filter((m) => m.score >= PROBLEM_TYPE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

/** 该知识点能解决哪些题型（反向索引） */
export function problemsForNode(problemTypes: ProblemType[], nodeId: string): ProblemType[] {
  return problemTypes.filter((p) => p.nodes.includes(nodeId));
}

/** 相关题型：共享知识点 + 同类打分 */
export function relatedProblems(problemTypes: ProblemType[], id: string): ProblemType[] {
  const p = problemTypes.find((x) => x.id === id);
  if (!p) return [];
  const myNodes = new Set(p.nodes);
  return problemTypes
    .filter((q) => q.id !== id)
    .map((q) => {
      let s = 0;
      for (const n of q.nodes) if (myNodes.has(n)) s += 2;
      if (q.category !== undefined && q.category === p.category) s += 3;
      return { q, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map((x) => x.q);
}

/** 喂 LLM 的紧凑索引（id|名|学段|主线）——LLM 只准从这里选 id，程序端二次校验防幻觉 */
export function nodeIndexText(index: GraphIndex): string {
  return index.graph.nodes
    .map((n) => `${n.id} | ${n.name} | ${n.stage} | ${n.strand}`)
    .join("\n");
}

export function problemIndexText(problemTypes: ProblemType[]): string {
  return problemTypes
    .map((p) => `${p.id} | ${p.name} | ${(p.keywords ?? []).slice(0, 4).join("/")}`)
    .join("\n");
}

/** 校验 LLM 返回的 id 列表（防幻觉：不存在的 id 一律丢弃） */
export function validateIds(known: Set<string>, ids: string[] | undefined, reason: string): LocatorMatch[] {
  const out: LocatorMatch[] = [];
  const seen = new Set<string>();
  (ids ?? []).forEach((id, i) => {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push({ id, score: 100 - i, reasons: [reason] });
    }
  });
  return out;
}
