import { randomUUID } from "node:crypto";
import type { Knowledge, RootCandidate } from "@mathtutor/knowledge";
import type { Question } from "@mathtutor/schema";
import type { Repo } from "./repo.js";
import type { QuestionStore } from "./questions.js";
import { practiceReady } from "./questions.js";
import type { HintProvider } from "./hint.js";
import { countsTowardMastery, effectiveP } from "./mastery.js";
import { nodeEvidenceCounts } from "./evidence.js";
import { normalizeText, parseNumeric } from "@mathtutor/subject-math";
import { REDACTED, redactAnswers } from "@mathtutor/core";
import { screenModelOutput } from "./safety.js";

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

/**
 * 模型写的那句错因，交出去之前先过两道确定性的筛。
 *
 * 为什么非筛不可：选根因时提示词里给了模型**正确答案**（它要对照学生答案才判得出错因），
 * 而这句话最终原样摆在孩子的归因卡上。"别提答案"写在提示词里靠不住——模型一顺嘴
 * 就会写出"应该得 7 而不是 3"。所以和课堂旁白用同一把尺子（@mathtutor/core 的
 * redactAnswers）硬剔，再过输出侧安检。
 *
 * 剔完只剩占位符和标点（整句就是在报答案）、或安检拦下，都换成确定性的那句：
 * 半截被抹过的话比一句干脆的替换更让人困惑。
 */
export function sanitizeDiagnosisExplanation(
  raw: unknown,
  answer: string,
  fallback: string,
  screen?: (text: string) => boolean,
): string {
  // 模型给的 JSON 里这个字段不保证是字符串
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return fallback;
  // 答案的几种书写：原样、以及数值答案的规范写法（"7.0"/"07" 这类原样匹配不上的形态）
  const forms = new Set([answer.trim()]);
  const num = parseNumeric(answer);
  if (num !== null) {
    forms.add(String(num));
    forms.add(num.toFixed(1));
    forms.add(num.toFixed(2).replace(/\.?0+$/, ""));
  }
  // 先剔再截：反过来截断会把答案截成一半（"126" → "12"），剔除就认不出了
  const redacted = redactAnswers(
    text,
    [...forms].filter(Boolean).map((a) => ({ answer: a })),
  ).text.slice(0, 60);
  const residue = redacted.split(REDACTED).join("").replace(/[\s\p{P}\p{S}]/gu, "");
  if (!residue) return fallback;
  if (screen?.(redacted)) return fallback;
  return redacted;
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
  /*
   * 证据要**排除这道题刚刚交上来的那一次错答**。
   *
   * 不排除的话归因会自我认证：错答先写了证据，题目自身节点的 evidenceN 变成 1，
   * 于是"verified 或有实证"的门槛总被这道错题自己满足，根因永远塌缩成
   * "题目自己那个节点"——沿前置回溯找根子的设计对新孩子完全不起作用。
   */
  const history = repo
    .attemptsForEvidence(attempt.learnerId)
    .filter((a) => !(a.questionId === attempt.questionId && a.at === attempt.at));
  const historicalCounts = nodeEvidenceCounts(history, questions);
  /*
   * 掌握度行是增量投影，看不出"这条证据是不是刚才那次错答写的"。
   * 但那一次错答只会给**题目自己挂的节点**各加 1，所以按节点身份扣掉它：
   * 题目自身节点从"有实证"里排除，前置节点原样保留。
   * 这一条是堵自证的关键——不然错题自己就把"有实证"的门槛满足了。
   */
  const thisCounted =
    !attempt.needsReview && countsTowardMastery(attempt.verification) && attempt.actor !== "parent";
  const masteryLookup = (nodeId: string) => {
    const row = repo.getMastery(attempt.learnerId, nodeId);
    const own = thisCounted && question.nodeIds.includes(nodeId) ? 1 : 0;
    const fromRow = row ? Math.max(0, row.evidenceN - own) : 0;
    const evidenceN = Math.max(historicalCounts.get(nodeId) ?? 0, fromRow);
    return { p: row ? effectiveP(row) : 0, evidenceN };
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
    explanation: sanitizeDiagnosisExplanation(
      selection.explanation,
      question.answer,
      eligible
        ? `这道题的根子可能在「${rootNode.name}」，先把它补牢。`
        : `暂定位到「${rootNode.name}」附近；已安排探针题进一步确认，先看讲解。`,
      (text) => screenModelOutput(repo, attempt.learnerId, text).blocked,
    ),
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
