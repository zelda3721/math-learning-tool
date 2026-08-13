/**
 * 语义核查：逐题问模型「这道题挂的知识点对不对」。
 *
 * 结构性的核查（id 存不存在、学段对不对、题型与知识点有没有交集）在 bank.ts 的
 * /audit 里，不用读题就能判。但真正常见的错法是**结构上完全合法、语义上不对**：
 * 一道数图形的题挂着「表内乘除法」，两边都在图谱里、学段也对，谁也看不出来。
 * 那种只能读题才判得了。
 *
 * 三条纪律：
 * ① **只报不改**。判卷、配图、答案出处一路下来都是这个规矩：模型说的不算数，
 *    人看过才算。何况这里判错的代价很实——知识点是诊断与复习的地基。
 * ② **建议必须落在图谱里**。模型会说「勾股定理应用」这种图谱没有的说法，
 *    一律吸附到真实 id，吸不上就丢掉（复用抽取那套 snapToGraph）。
 * ③ **候选清单按学段筛**。全量 123 个既费 token 又诱导跨学段乱选——
 *    一道小学数图形的题被判成高中「解三角形」，我们见过。
 *
 * 本地模型单卡，逐题串行；170 道大约 20 分钟，所以做成后台任务带进度。
 */
import type { Knowledge } from "@mathtutor/knowledge";
import type { Question } from "@mathtutor/schema";
import { LlmClient, loadLlmConfig, type ChatMessage } from "@mathtutor/llm-client";
import { candidateNodes, snapToGraph } from "./ingest/vocabulary.js";

/**
 * 存疑的分档。混在一起给人看等于没给——实测 170 道跑出 96 条存疑，
 * 其中真正值得改的只有 63 条，另外 33 条是两类可预期的噪声。
 */
export type DisputeKind =
  /** 同学段的真建议——这些才值得逐条看 */
  | "actionable"
  /**
   * 建议里有跨学段的节点。实测 24 条，其中 18 条都是把小学题往
   * 「一元一次方程与方程组」上带——用方程解小学奥数题在数学上不算错，
   * 但对小学生的知识点标注是错的，照着改会让星图点亮初中的星。
   */
  | "cross-stage"
  /** 建议只是现有知识点的子集——模型想删掉一个，算不上"标错" */
  | "narrower";

export interface AuditVerdict {
  questionId: string;
  stem: string;
  /** 模型认为现有知识点合适 */
  ok: boolean;
  current: string[];
  /** 知识点的名字——界面上只显示 id 没法看 */
  currentNames: string[];
  /** 模型建议改成的知识点（已吸附到真实 id；可能为空） */
  suggested: string[];
  suggestedNames: string[];
  why: string;
  kind: DisputeKind;
}

export interface SemanticAuditResult {
  checked: number;
  /** 模型认为不合适的那些，按 kind 分档（先看 actionable） */
  disputed: AuditVerdict[];
  /** 各档条数，让人一眼知道该看多少 */
  byKind: Record<DisputeKind, number>;
  /** 模型给了图谱里没有的说法——这是"我们缺哪个节点"的线索 */
  dropped: string[];
}

export interface AuditProgress {
  done: number;
  total: number;
  disputed: number;
}

const SYSTEM = "你在核查数学题的知识点标注是否恰当。只输出一个 JSON 对象，不要解释。";

export function auditPrompt(
  knowledge: Knowledge,
  question: Pick<Question, "stem" | "answer" | "level" | "nodeIds">,
): string {
  const byId = knowledge.index.nodeById;
  const current = question.nodeIds.map((id) => `${id}(${byId.get(id)?.name ?? "?"})`).join("、");
  const list = candidateNodes(knowledge, question.level)
    .map((n) => `${n.id}(${n.name})`)
    .join("、");
  return [
    `题目：${question.stem}`,
    `答案：${question.answer}`,
    `当前挂的知识点：${current || "（无）"}`,
    "",
    "这道题考的**主要能力**是不是当前这些知识点？输出：",
    '{"ok":true 或 false,"better":["知识点id", ...],"why":"一句话说明"}',
    "",
    "判断标准：看这道题**要用到什么才做得出来**，不是题面里出现了什么词。",
    "「数一数图中有多少个三角形」考的是有序枚举，不是三角形的性质；",
    "「小明有12个苹果平均分给4人」考的是除法的意义，不是加减法。",
    "",
    "当前知识点合适就 ok=true、better 留空数组。",
    "不合适才给 better，**只能从下面的清单里选**（1~3 个）：",
    list,
  ].join("\n");
}

function parseVerdict(raw: string): { ok: boolean; better: unknown; why: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    return {
      ok: o.ok === true,
      better: o.better,
      why: typeof o.why === "string" ? o.why.trim() : "",
    };
  } catch {
    return null;
  }
}

/**
 * 逐题核查。串行——本地模型单卡，并发只会排队，还会让进度失真。
 * 单题失败不中断：核查是锦上添花，不该因为一道读不出来就整批白跑。
 */
/** 只用到 chat 这一件事；抽成接口是为了能塞假模型进来测（真 client 会去连网络） */
export interface AuditChat {
  chat(
    messages: ChatMessage[],
    opts?: { maxTokens?: number; temperature?: number },
  ): AsyncIterable<{ type: string; text?: string }>;
}

export async function runSemanticAudit(
  knowledge: Knowledge,
  questions: Question[],
  opts: {
    onProgress?: (p: AuditProgress) => void;
    env?: NodeJS.ProcessEnv;
    chat?: AuditChat;
  } = {},
): Promise<SemanticAuditResult> {
  const client: AuditChat =
    opts.chat ?? LlmClient.fromEndpoint(loadLlmConfig(opts.env ?? process.env).fast);
  const disputed: AuditVerdict[] = [];
  const dropped = new Set<string>();
  const nameOf = (id: string) => knowledge.index.nodeById.get(id)?.name ?? id;

  for (const [i, q] of questions.entries()) {
    opts.onProgress?.({ done: i, total: questions.length, disputed: disputed.length });
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: auditPrompt(knowledge, q) },
    ];
    let raw = "";
    try {
      for await (const ev of client.chat(messages, { maxTokens: 512, temperature: 0.1 })) {
        if (ev.type === "text") raw += ev.text;
      }
    } catch {
      continue; // 这一道问不出来就跳过，别拖垮整批
    }
    const verdict = parseVerdict(raw);
    if (!verdict || verdict.ok) continue;

    /**
     * 模型的说法一律吸附到真实 id：图谱里没有的宁可丢掉，也不能凭空造节点。
     * **不要退回关键词匹配**（最后那个 false）——核查报告的是"模型建议改成什么"，
     * 退回关键词就会报出一条模型根本没提过的建议，人照着改反而把对的改坏。
     */
    const snapped = snapToGraph(knowledge, { nodeIds: verdict.better }, q.stem, false);
    for (const d of snapped.dropped) dropped.add(d);
    // 建议和现有一模一样就不算争议——模型只是换了个说法
    const same =
      snapped.nodeIds.length === q.nodeIds.length &&
      snapped.nodeIds.every((n) => q.nodeIds.includes(n));
    if (same || snapped.nodeIds.length === 0) continue;

    const stage = LEVEL_STAGE[q.level];
    const kind: DisputeKind = snapped.nodeIds.some(
      (id) => knowledge.index.nodeById.get(id)?.stage !== stage,
    )
      ? "cross-stage"
      : snapped.nodeIds.every((id) => q.nodeIds.includes(id))
        ? "narrower"
        : "actionable";

    disputed.push({
      questionId: q.id,
      stem: q.stem.slice(0, 40),
      ok: false,
      current: q.nodeIds,
      currentNames: q.nodeIds.map(nameOf),
      suggested: snapped.nodeIds,
      suggestedNames: snapped.nodeIds.map(nameOf),
      why: verdict.why,
      kind,
    });
  }
  opts.onProgress?.({ done: questions.length, total: questions.length, disputed: disputed.length });
  // 值得看的排前面：人从上往下看就是从最该改的开始
  const order: DisputeKind[] = ["actionable", "cross-stage", "narrower"];
  disputed.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const byKind = { actionable: 0, "cross-stage": 0, narrower: 0 } as Record<DisputeKind, number>;
  for (const d of disputed) byKind[d.kind] += 1;
  return { checked: questions.length, disputed, byKind, dropped: [...dropped] };
}

/** 年级 → 学段 */
const LEVEL_STAGE: Record<Question["level"], string> = {
  elementary_lower: "primary",
  elementary_upper: "primary",
  middle: "junior",
  high: "senior",
  advanced: "university",
};
