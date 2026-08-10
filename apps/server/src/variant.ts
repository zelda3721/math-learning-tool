import { randomUUID } from "node:crypto";
import type { Question } from "@mathtutor/schema";
import { QuestionSchema } from "@mathtutor/schema";
import type { Repo } from "./repo.js";
import type { QuestionStore } from "./questions.js";
import type { HintProvider } from "./hint.js";
import { appendQuestions, contentHashOf } from "./questions.js";

/**
 * 变式题供给（宪法第 1、3 条的执行机制，设计 §06）：
 * ① 题库检索（variantOf 组 / 同题型 / 同节点，难度相近，没做对过）
 * ② LLM 参数化改造（限 numeric/expression；生成题入库标 generated，进家长抽检）
 * ③ 都不可用 → null（调用方把点亮推迟到复习队列）
 */

export type VariantResult =
  | { kind: "bank" | "generated"; question: Question }
  | { kind: "none" };

function variantGroup(q: Question): string {
  return q.variantOf ?? q.id;
}

export async function getVariant(args: {
  store: QuestionStore;
  repo: Repo;
  llm: HintProvider | null;
  dataDir: string;
  learnerId: string;
  questionId: string;
}): Promise<VariantResult | { error: string }> {
  const { store, repo, llm, dataDir, learnerId, questionId } = args;
  const original = store.byId.get(questionId);
  if (!original) return { error: "题目不存在" };
  const doneRecently = repo.recentlyCorrectQuestionIds(learnerId, 3);

  const usable = (q: Question) =>
    q.id !== original.id &&
    !doneRecently.has(q.id) &&
    Math.abs(q.difficulty - original.difficulty) <= 1 &&
    q.answerType !== "steps";

  // ① 题库检索：variantOf 同组 > 同题型 > 同节点
  const group = variantGroup(original);
  const fromGroup = store.all.find((q) => usable(q) && variantGroup(q) === group);
  if (fromGroup) return { kind: "bank", question: fromGroup };
  if (original.problemTypeId) {
    const fromType = store.all.find((q) => usable(q) && q.problemTypeId === original.problemTypeId);
    if (fromType) return { kind: "bank", question: fromType };
  }
  for (const nodeId of original.nodeIds) {
    const fromNode = (store.byNode.get(nodeId) ?? []).find(usable);
    if (fromNode) return { kind: "bank", question: fromNode };
  }

  // ② LLM 参数化改造：换数字/情境，答案必须可确定性判卷
  if (llm && original.answerType !== "steps") {
    try {
      const raw = await llm.generate(
        `把这道数学题改成一道同类变式题：换掉数字和情境，考点和解法完全一致，难度相同。\n原题：${original.stem}\n原答案：${original.answer}\n` +
          `输出 JSON（不要其他文字）：{"stem":"新题干","answer":"新答案（数值题只写数）"}\n要求：answer 必须是你对新题干严格计算后的结果。`,
      );
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(raw.slice(start, end + 1)) as { stem?: string; answer?: string };
        if (parsed.stem && parsed.answer && parsed.stem.length >= 8) {
          const candidate = QuestionSchema.safeParse({
            id: `gen-${randomUUID().slice(0, 8)}`,
            problemTypeId: original.problemTypeId,
            nodeIds: original.nodeIds,
            level: original.level,
            stem: parsed.stem,
            answer: parsed.answer,
            answerType: original.answerType,
            difficulty: original.difficulty,
            source: { role: "generated" },
            variantOf: original.id,
            contentHash: contentHashOf(parsed.stem, parsed.answer),
            status: "extracted", // 生成题进家长抽检（初期全量复核，设计 §10）
          });
          if (candidate.success) {
            const { written } = appendQuestions(dataDir, "generated-variants", [candidate.data], store);
            if (written.length) {
              store.reload();
              return { kind: "generated", question: candidate.data };
            }
          }
        }
      }
    } catch {
      // fall through to none
    }
  }

  // ③ 降级：点亮推迟到 SM-2 复习卡（明天同组换题再练）
  repo.upsertReviewCard(learnerId, "question", original.id, new Date(Date.now() + 20 * 3600_000).toISOString());
  return { kind: "none" };
}
