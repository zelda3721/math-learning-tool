import { randomUUID } from "node:crypto";
import type { Question } from "@mathtutor/schema";
import { QuestionSchema } from "@mathtutor/schema";
import type { Repo } from "./repo.js";
import type { QuestionStore } from "./questions.js";
import type { HintProvider } from "./hint.js";
import { appendQuestions, contentHashOf, practiceReady } from "./questions.js";

/**
 * 变式题供给（宪法第 1、3 条的执行机制，设计 §06）：
 * ① 题库检索（variantOf 组 / 同题型 / 同节点，难度相近，没做对过）
 * ② LLM 参数化改造（限 numeric/expression）。**只做得进抽检队列的候选，
 *    不能当场当成交式门的凭据**：模型给自己的答案，没人核对过就不算数
 *    （见 answerUnverified 那一段）。核对过之后它才是一道正常题。
 * ③ 都不可用 → null（调用方把点亮推迟到复习队列）
 */

export type VariantResult =
  /**
   * `generated` 仅表示"这道题来自模型生成"这个来历，**它不会作为变式门的凭据下发**：
   * 生成的题答案还没人核对，practiceReady 不放行，见下方 ②。
   * 保留这个取值的用途是给调用方区分"题库原题"与"模型出的题"（抽检、统计）。
   */
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
    practiceReady(q) &&
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
            /*
             * 答案是模型自己算的，**必须标出来**。
             *
             * 这条线是本模块最容易走错的一步：变式题存在的意义就是"做对才算懂"，
             * 而它的参考答案如果没人核对过，"做对"这个判定本身就悬空——
             * 孩子会被一个算错的参考值判错，掌握度却按这次作答改写。
             * 同一条规矩在抽题那边已经守着了（见 questions.ts 的 practiceReady），
             * 这里以前漏了：入库时不标 answerUnverified，判卷器就一律按 executable
             * 记账，等于让模型的算术去点亮节点。
             *
             * 标上之后 practiceReady 会挡住它：这孩子今天的点亮走 ③（推迟到复习卡），
             * 题目留在库里等家长核对，核对过才发得出去。
             */
            answerUnverified: true,
            status: "extracted", // 生成题进家长抽检（初期全量复核，设计 §10）
          });
          if (candidate.success) {
            const { written } = appendQuestions(dataDir, "generated-variants", [candidate.data], store);
            if (written.length) {
              store.reload();
              // 只进家长抽检队列，不当成交式门的凭据：这道题今天不给这个孩子。
              repo.appendEvent(learnerId, "variant_generated", {
                questionId: candidate.data.id,
                variantOf: original.id,
                why: "答案由模型给出、尚无核对，不进变式门",
              });
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
