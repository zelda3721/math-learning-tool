import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { GraphSchema, type Question, type Source } from "@mathtutor/schema";
import { lint, loadKnowledge, type Knowledge } from "@mathtutor/knowledge";
import type { QuestionStore } from "./questions.js";

/**
 * 知识层管理通道（P1b）：所有修改都走 file-first + lint 闸门 + reload，
 * 禁止绕过文件直接改内存/DB（设计 §06 纪律）。
 */

export interface CoverageRow {
  nodeId: string;
  name: string;
  stage: string;
  strand: string;
  status: string;
  questionCount: number;
  verifiedQuestionCount: number;
}

export interface CoverageReport {
  nodes: CoverageRow[];
  /** 图谱缺口：无任何题目命中的节点（按学段分组的 id 列表） */
  uncoveredByStage: Record<string, string[]>;
  /** 核验候选：命中题数最多但尚未 verified 的前 20 节点（验收指标） */
  topUnverified: CoverageRow[];
  totals: { nodes: number; covered: number; verifiedNodes: number; questions: number };
}

export function buildCoverage(knowledge: Knowledge, store: QuestionStore): CoverageReport {
  const rows: CoverageRow[] = knowledge.graph.nodes.map((n) => {
    const qs = store.byNode.get(n.id) ?? [];
    return {
      nodeId: n.id,
      name: n.name,
      stage: n.stage,
      strand: n.strand,
      status: n.status,
      questionCount: qs.length,
      verifiedQuestionCount: qs.filter((q) => q.status === "verified").length,
    };
  });
  const uncoveredByStage: Record<string, string[]> = {};
  for (const r of rows) {
    if (r.questionCount === 0) {
      if (!uncoveredByStage[r.stage]) uncoveredByStage[r.stage] = [];
      uncoveredByStage[r.stage]!.push(r.nodeId);
    }
  }
  const topUnverified = rows
    .filter((r) => r.status !== "verified" && r.questionCount > 0)
    .sort((a, b) => b.questionCount - a.questionCount)
    .slice(0, 20);
  return {
    nodes: rows.sort((a, b) => b.questionCount - a.questionCount),
    uncoveredByStage,
    topUnverified,
    totals: {
      nodes: rows.length,
      covered: rows.filter((r) => r.questionCount > 0).length,
      verifiedNodes: rows.filter((r) => r.status === "verified").length,
      questions: store.all.length,
    },
  };
}

/**
 * 节点核验：graph.json 里把 status 置为 verified（可附 sources），
 * 写文件前跑 lint（errors 非空即拒绝），成功后调用方需重载 knowledge。
 */
export function verifyNode(
  dataDir: string,
  nodeId: string,
  source?: Source,
): { ok: true; knowledge: Knowledge } | { ok: false; error: string } {
  const graphPath = path.join(dataDir, "knowledge", "graph.json");
  const raw = JSON.parse(readFileSync(graphPath, "utf8"));
  const parsed = GraphSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `graph.json 解析失败: ${parsed.error.issues[0]?.message}` };
  const node = (raw.nodes as { id: string; status?: string; sources?: Source[] }[]).find(
    (n) => n.id === nodeId,
  );
  if (!node) return { ok: false, error: `节点不存在: ${nodeId}` };
  const before = { status: node.status, sources: node.sources };
  node.status = "verified";
  if (source) node.sources = [...(node.sources ?? []), source];

  const candidate = GraphSchema.safeParse(raw);
  if (!candidate.success) {
    return { ok: false, error: `修改后 schema 校验失败: ${candidate.error.issues[0]?.message}` };
  }
  const report = lint(candidate.data, []);
  if (report.errors.length) {
    node.status = before.status;
    node.sources = before.sources;
    return { ok: false, error: `lint 未通过，拒绝写入: ${report.errors[0]}` };
  }
  writeFileSync(graphPath, JSON.stringify(raw, null, 2), "utf8");
  const knowledge = loadKnowledge({
    graphPath,
    problemsPath: path.join(dataDir, "knowledge", "problems.json"),
  });
  return { ok: true, knowledge };
}

export interface ReviewResult {
  ok: boolean;
  error?: string;
  file?: string;
}

/**
 * 题目抽检裁决：verified（可带 patch 修正）或 rejected（从批次文件移除）。
 * 直接编辑所在批次文件，调用方需 store.reload()。
 */
export function reviewQuestion(
  dataDir: string,
  questionId: string,
  verdict: "verified" | "rejected",
  patch?: Partial<Pick<Question, "stem" | "answer" | "answerType" | "difficulty" | "nodeIds" | "analysis">>,
): ReviewResult {
  const dir = path.join(dataDir, "knowledge", "questions");
  if (!existsSync(dir)) return { ok: false, error: "题库目录不存在" };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const full = path.join(dir, file);
    const items = JSON.parse(readFileSync(full, "utf8")) as Question[];
    const idx = items.findIndex((q) => q.id === questionId);
    if (idx === -1) continue;
    if (verdict === "rejected") {
      items.splice(idx, 1);
    } else {
      items[idx] = { ...items[idx]!, ...patch, status: "verified" };
    }
    writeFileSync(full, JSON.stringify(items, null, 2), "utf8");
    return { ok: true, file };
  }
  return { ok: false, error: `题目不存在: ${questionId}` };
}
