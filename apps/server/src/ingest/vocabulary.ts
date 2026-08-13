/**
 * 让抽取模型直接点名知识点与题型——但只能从图谱里选。
 *
 * 为什么要它：离线匹配器靠字面包含，遇到「共有多少种不同的走法」这类题
 * 永远够不着「计数原理」——题干里根本没有这四个字。而「题里出现了三角形」
 * 与「这是一道解三角形的题」的区别，也不是关键词分得清的。
 * 模型本来就在逐题读题干，顺手让它判断，几乎不增加成本。
 *
 * 但不能让它自由发挥：模型给的名字会是「勾股定理应用」「三角形面积」这类
 * 图谱里并不存在的说法。所以给它一份候选清单，回来再逐个吸附到真实 id，
 * 吸不上的丢掉——**图谱里没有的知识点，宁可空着也不能凭空造一个**，
 * 否则星图会长出根本不存在的节点，掌握度也就无从统计。
 */
import type { Knowledge } from "@mathtutor/knowledge";
import { matchOffline } from "@mathtutor/knowledge";
import type { EducationLevel } from "@mathtutor/schema";

/** 年级 → 学段（图谱按学段组织，材料按年级上传） */
const LEVEL_STAGE: Record<EducationLevel, string> = {
  elementary_lower: "primary",
  elementary_upper: "primary",
  middle: "junior",
  high: "senior",
  advanced: "university",
};

const STAGE_ORDER = ["primary", "junior", "senior", "university"];

/**
 * 候选清单。按材料年级取本学段与相邻学段——
 * 全量 123 个塞进提示词既费 token 又会诱导模型跨学段乱选
 * （一道小学数图形的题被判成高中「解三角形」，我们已经见过）。
 */
export function candidateNodes(knowledge: Knowledge, level?: EducationLevel) {
  const nodes = knowledge.graph.nodes;
  if (!level) return nodes;
  const target = LEVEL_STAGE[level];
  const i = STAGE_ORDER.indexOf(target);
  const allowed = new Set([STAGE_ORDER[i], STAGE_ORDER[i - 1], STAGE_ORDER[i + 1]].filter(Boolean) as string[]);
  const picked = nodes.filter((n) => allowed.has(n.stage));
  return picked.length ? picked : nodes;
}

/** 拼进系统提示词的清单文本：id 与名字都给，模型给哪个都能吸附 */
export function vocabularyPrompt(knowledge: Knowledge, level?: EducationLevel): string {
  const nodes = candidateNodes(knowledge, level);
  const nodeList = nodes.map((n) => `${n.id}(${n.name})`).join("、");
  const types = knowledge.problemTypes
    .filter((t) => !level || t.stage === LEVEL_STAGE[level] || LEVEL_STAGE[level] === "university")
    .map((t) => `${t.id}(${t.name})`)
    .join("、");
  return [
    "",
    "**还要判断这道题考的是什么**，加两个字段：",
    '"nodeIds":["知识点id", ...]（1~3 个，从下面的清单里选，可以多选）',
    '"problemTypeId":"题型id"（这道题属于哪个经典题型；从下面的题型清单里选）',
    "",
    `知识点清单：${nodeList}`,
    types ? `题型清单：${types}` : "",
    "",
    "只能从清单里选。",
    "",
    "**知识点宁可空着，题型宁可标上**——这两者的代价不对称：",
    "错的知识点会让诊断与复习都跑偏（那是整套系统的地基），所以清单里没有合适的就留空数组；",
    "而题型只是这道题的**解法归类**，标错顶多让讲解多给一句提示，漏标却让那句提示永远没有——",
    "「年龄问题」的本质是「年龄差永远不变」，那正是这类题唯一要讲的东西，漏了就只剩「这道题这么算」。",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface SnapResult {
  nodeIds: string[];
  problemTypeId?: string;
  /** 被丢弃的提议（家长抽检时能看到模型都想选什么） */
  dropped: string[];
}

/**
 * 把模型给的说法吸附到真实 id。
 * 依次尝试：真实 id → 节点名精确匹配 → 拿这个说法过一遍离线匹配器。
 * 三条都不中就丢弃并记下来。
 */
export function snapToGraph(
  knowledge: Knowledge,
  proposed: { nodeIds?: unknown; problemTypeId?: unknown },
  stem: string,
  /**
   * 一个都吸不上时，要不要退回关键词匹配。
   *
   * **抽取时要**（总比让题目没有知识点强），**核查时不要**：
   * 核查报告的是"模型建议改成什么"，退回关键词就会报出一条模型根本没提过的建议，
   * 人照着改反而把对的改坏。默认 true 是为了不动既有调用。
   */
  fallbackToOffline = true,
): SnapResult {
  const byId = knowledge.index.nodeById;
  const byName = new Map(knowledge.graph.nodes.map((n) => [n.name, n.id]));
  const out: string[] = [];
  const dropped: string[] = [];

  const raw = Array.isArray(proposed.nodeIds) ? proposed.nodeIds : [];
  for (const item of raw.slice(0, 5)) {
    const text = String(item ?? "").trim();
    if (!text) continue;
    if (byId.has(text)) { push(out, text); continue; }
    const named = byName.get(text);
    if (named) { push(out, named); continue; }
    // 模型可能给了近似说法（"勾股定理应用"）：用它自己过一遍匹配器
    const guess = matchOffline(knowledge.index, text, 1)[0];
    if (guess && guess.score > 8) { push(out, guess.id); continue; }
    dropped.push(text);
  }

  // 一个都没吸上时退回离线匹配器——总比让题目没有知识点强
  if (out.length === 0 && fallbackToOffline) {
    for (const m of matchOffline(knowledge.index, stem, 3)) push(out, m.id);
  }

  let problemTypeId: string | undefined;
  const pt = String(proposed.problemTypeId ?? "").trim();
  if (pt) {
    const hit =
      knowledge.problemTypes.find((t) => t.id === pt) ??
      knowledge.problemTypes.find((t) => t.name === pt);
    if (hit) problemTypeId = hit.id;
    else dropped.push(pt);
  }

  return { nodeIds: out.slice(0, 4), problemTypeId, dropped };
}

function push(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
}
