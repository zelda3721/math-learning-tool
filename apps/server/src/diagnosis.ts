import { randomUUID } from "node:crypto";
import type { Knowledge, RootCandidate } from "@mathtutor/knowledge";
import type { Question } from "@mathtutor/schema";
import type { Repo } from "./repo.js";
import type { QuestionStore } from "./questions.js";
import { practiceReady } from "./questions.js";
import type { HintProvider } from "./hint.js";
import { effectiveP } from "./mastery.js";
import { normalizeText } from "./grading.js";

/**
 * 诊断归因（设计 §06/§07）：归因主链是代码，LLM 只在候选集内做受限选择。
 * 宪法第 4 条：归因必须带证据与置信度；第 6 条：未核验的知识不承重。
 */

export interface DiagnosisResult {
  mistakeId: string;
  /** 承重归因：根因节点 verified 或有实证；false = 只给定位不给根因 */
  eligible: boolean;
  surface: "concept" | "procedure" | "calculation" | "reading";
  rootNodeId: string;
  rootNodeName: string;
  misconceptionId?: string;
  misconceptionDesc?: string;
  /** 依据知识链：题目节点 → … → 根因（节点 id 顺序），UI 明示 */
  chain: string[];
  chainNames: string[];
  confidence: number;
  explanation: string;
  /** 已排进次日队列的探针题 id（作答结果回填归因证据） */
  probesQueued: string[];
}

interface LlmSelection {
  rootNodeId?: string;
  misconceptionId?: string;
  surface?: string;
  explanation?: string;
}

/** 从题目节点沿 prerequisites 用 BFS 重建到根因的最短链 */
export function buildChain(knowledge: Knowledge, fromNodeIds: string[], rootId: string): string[] {
  const parent = new Map<string, string>();
  const queue = [...fromNodeIds];
  const seen = new Set(fromNodeIds);
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === rootId) {
      // parent 指针从根因走回题目节点：链序 = 根因 → … → 题目（学习顺序）
      const chain = [cur];
      let p = parent.get(cur);
      while (p !== undefined) {
        chain.push(p);
        p = parent.get(p);
      }
      return chain;
    }
    for (const pre of knowledge.index.getNode(cur)?.prerequisites ?? []) {
      if (!seen.has(pre)) {
        seen.add(pre);
        parent.set(pre, cur);
        queue.push(pre);
      }
    }
  }
  return [rootId];
}

function parseSelection(raw: string): LlmSelection {
  const stripped = raw.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as LlmSelection;
  } catch {
    return {};
  }
}

const SURFACES = new Set(["concept", "procedure", "calculation", "reading"]);

export async function diagnoseMistake(args: {
  knowledge: Knowledge;
  questions: QuestionStore;
  repo: Repo;
  llm: HintProvider | null;
  attemptId: string;
}): Promise<DiagnosisResult | { error: string }> {
  const { knowledge, questions, repo, llm, attemptId } = args;
  const attempt = repo.getAttempt(attemptId);
  if (!attempt) return { error: "attempt 不存在" };
  if (attempt.correct) return { error: "该次作答是正确的，无需归因" };
  const question = questions.byId.get(attempt.questionId);
  if (!question) return { error: "题目不存在" };

  // 1) 确定性候选：沿 prerequisites 回溯掌握度低/无证据的祖先
  const masteryLookup = (nodeId: string) => {
    const row = repo.getMastery(attempt.learnerId, nodeId);
    return row ? { p: effectiveP(row), evidenceN: row.evidenceN } : undefined;
  };
  const candidates = knowledge.index.traceRootCandidates(question.nodeIds, masteryLookup);
  // 题目自身节点也是候选（错在当前知识而非前置的情形），排在回溯候选之后
  for (const nodeId of question.nodeIds) {
    if (!candidates.some((c) => c.nodeId === nodeId)) {
      const m = masteryLookup(nodeId);
      candidates.push({
        nodeId,
        depth: 0,
        p: m?.p ?? 0,
        evidenceN: m?.evidenceN ?? 0,
        reason: m && m.evidenceN > 0 ? "low-mastery" : "no-evidence",
      });
    }
  }
  if (!candidates.length) return { error: "无归因候选（图谱无前置且题目节点缺失）" };

  // 2) 承重门槛（宪法第 6 条）：verified 或有实证（做题/探针证据）
  const isEligible = (c: RootCandidate) =>
    knowledge.index.getNode(c.nodeId)?.status === "verified" || c.evidenceN > 0;
  const eligibleCandidates = candidates.filter(isEligible);
  const pool = eligibleCandidates.length ? eligibleCandidates : candidates;
  const eligible = eligibleCandidates.length > 0;

  // 3) LLM 在候选集内受限选择（防幻觉：id 程序校验；LLM 不可用走确定性兜底）
  const poolInfo = pool.slice(0, 6).map((c) => {
    const node = knowledge.index.getNode(c.nodeId)!;
    return {
      id: c.nodeId,
      name: node.name,
      p: Math.round(c.p * 100) / 100,
      misconceptions: node.misconceptions.map((m) => ({ id: m.id, desc: m.desc })),
    };
  });
  let selection: LlmSelection = {};
  if (llm) {
    try {
      const raw = await llm.generate(
        `学生做错了这道题：${question.stem}\n学生答案：${attempt.answer}\n正确答案：${question.answer}\n` +
          `候选薄弱知识点（只能从中选择）：${JSON.stringify(poolInfo, null, 1)}\n` +
          `请输出 JSON（不要其他文字）：{"rootNodeId":"候选中的 id","misconceptionId":"该节点误概念 id 或省略","surface":"concept|procedure|calculation|reading","explanation":"一句话向家长解释错因，不超过40字"}`,
      );
      selection = parseSelection(raw);
    } catch {
      selection = {};
    }
  }

  // 程序校验：rootNodeId 必须在候选集内，misconceptionId 必须属于该节点
  const validRoot = pool.find((c) => c.nodeId === selection.rootNodeId) ? selection.rootNodeId! : pool[0]!.nodeId;
  const rootNode = knowledge.index.getNode(validRoot)!;
  let misconceptionId = rootNode.misconceptions.some((m) => m.id === selection.misconceptionId)
    ? selection.misconceptionId
    : undefined;
  // 兜底：signals 规则匹配（规范化后的学生答案/题干文本）
  if (!misconceptionId) {
    const haystack = normalizeText(attempt.answer + " " + question.stem);
    misconceptionId = rootNode.misconceptions.find((m) =>
      m.signals.some((s) => s.length >= 2 && haystack.includes(normalizeText(s))),
    )?.id;
  }
  const surface = (SURFACES.has(selection.surface ?? "") ? selection.surface : "concept") as DiagnosisResult["surface"];
  const usedLlm = Boolean(selection.rootNodeId);

  // 4) 置信度：证据驱动的确定性公式（固定参数启发式，永不宣称精准）
  const rootCandidate = pool.find((c) => c.nodeId === validRoot)!;
  let confidence = 0.35;
  if (rootNode.status === "verified") confidence += 0.2;
  if (rootCandidate.evidenceN > 0) confidence += 0.15;
  if (rootCandidate.reason === "low-mastery") confidence += 0.1;
  if (usedLlm) confidence += 0.1;
  confidence = Math.min(0.9, Math.max(0.2, confidence));

  const chain = buildChain(knowledge, question.nodeIds, validRoot);

  // 5) 探针入队（次日组卷器消费；作答结果回填证据，是未核验节点的替代证据通道）
  const probesQueued: string[] = [];
  const tomorrow = new Date(Date.now() + 6 * 3600_000).toISOString(); // 6h 后即视为「次日可取」
  const attempted = repo.attemptedQuestionIds(attempt.learnerId);
  const probeTargets = candidates.slice(0, 2).map((c) => c.nodeId);
  for (const nodeId of probeTargets) {
    const probe = (questions.byNode.get(nodeId) ?? []).find(
      (q) => q.id !== question.id && !attempted.has(q.id) && q.difficulty <= 3 && practiceReady(q),
    );
    if (probe && probesQueued.length < 2) {
      repo.pushQueueItem(attempt.learnerId, "probe", probe.id, tomorrow);
      probesQueued.push(probe.id);
    }
  }

  // 6) 落库
  const mistakeId = randomUUID();
  repo.insertMistake({
    id: mistakeId,
    attemptId,
    learnerId: attempt.learnerId,
    questionId: question.id,
    surface,
    rootNodeId: validRoot,
    misconceptionId,
    chain,
    confidence,
    eligible,
  });
  repo.appendEvent(attempt.learnerId, "diagnosis", {
    mistakeId,
    rootNodeId: validRoot,
    misconceptionId,
    confidence,
    eligible,
    probesQueued,
  });

  return {
    mistakeId,
    eligible,
    surface,
    rootNodeId: validRoot,
    rootNodeName: rootNode.name,
    misconceptionId,
    misconceptionDesc: rootNode.misconceptions.find((m) => m.id === misconceptionId)?.desc,
    chain,
    chainNames: chain.map((id) => knowledge.index.getNode(id)?.name ?? id),
    confidence,
    explanation:
      selection.explanation?.slice(0, 60) ??
      (eligible
        ? `这道题的根子可能在「${rootNode.name}」，先把它补牢。`
        : `暂定位到「${rootNode.name}」附近；已安排探针题进一步确认，先看讲解。`),
    probesQueued,
  };
}

/**
 * 探针作答回填（宪法第 4 条：探针作答是证据）：
 * 探针做错 → 佐证根因，置信度上调；做对 → 反证，置信度下调。
 */
export function backfillProbeEvidence(
  repo: Repo,
  learnerId: string,
  probeQuestion: Question,
  correct: boolean,
): number {
  let updated = 0;
  for (const nodeId of probeQuestion.nodeIds) {
    for (const mistake of repo.openMistakesByRoot(learnerId, nodeId)) {
      const next = correct
        ? Math.max(0.15, mistake.confidence - 0.25)
        : Math.min(0.95, mistake.confidence + 0.2);
      repo.updateMistakeConfidence(mistake.id, next, true);
      updated++;
    }
  }
  if (updated) {
    repo.appendEvent(learnerId, "probe_result", {
      questionId: probeQuestion.id,
      correct,
      mistakesUpdated: updated,
    });
  }
  return updated;
}
