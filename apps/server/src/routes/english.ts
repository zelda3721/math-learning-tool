import { Hono } from "hono";
import { z } from "zod";
import { effectiveLearnerId, type AppState } from "../app.js";
import { judgeVocab, loadVocabulary, recordVocabAnswer, vocabBatch, type VocabCard } from "../vocabulary.js";
import { judgeReading, loadReading, publicPassage } from "../reading.js";
import { moduleBlockedBody, moduleEnabled } from "../modules.js";
import { budgetBlockedPayload } from "../chatBudget.js";

/**
 * 英语学习入口：词汇（SM-2）与分级阅读。
 *
 * 两条线共用一个路由文件，因为它们共用同一条纪律：**答案有出处、判定可复核**。
 * 词汇的出处是词表，阅读的出处是原文里那一句；两者都记 `reference` 证据，
 * 不冒充 executable（英语拿不出可执行验算，硬说成可执行就是骗人）。
 *
 * 英语有自己的模块开关（english）：家长关掉探索/课堂时词表照旧可学，
 * 但也可以单独把英语关掉——"今天先做数学"是家长正常的决定。
 */

const VocabAnswerSchema = z.object({
  learnerId: z.string().min(1),
  wordId: z.string().min(1),
  answer: z.string().max(120),
  direction: z.enum(["en2zh", "zh2en"]).optional(),
  /**
   * 答错后「再记一次」的重答。
   *
   * 重答**不推进 SM-2**：孩子刚看过参考答案，这一次的"对"不是提取出来的，
   * 拿它当间隔排期的依据，等于用开卷考试的成绩决定什么时候再复习。
   * 判卷照常返回，进度停在答错那一步（明天再来）。
   */
  retry: z.boolean().optional(),
});

const ReadingAnswerSchema = z.object({
  learnerId: z.string().min(1),
  passageId: z.string().min(1),
  questionId: z.string().min(1),
  answer: z.string().max(300),
});

export function englishRoutes(state: AppState): Hono {
  const app = new Hono();

  // 词表 + 阅读都按需加载一次：内容是文件，读一次就够（改文件要重启，和题库一致）
  let vocabulary: VocabCard[] | null = null;
  const cards = (): VocabCard[] => {
    vocabulary ??= loadVocabulary();
    return vocabulary;
  };
  const reading = loadReading();

  app.get("/vocabulary/today", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    // 学英语也算使用时长：时长闸不该只拦数学练习
    const blocked = budgetBlockedPayload(state.repo, learnerId);
    if (blocked) return c.json(blocked, 429);

    const batch = vocabBatch(state.repo, learnerId, cards());
    return c.json({
      ...batch,
      note:
        batch.newWords.length + batch.reviews.length === 0
          ? "今天的词都复习完了，明天再来。"
          : "先复习到期的，再学新词；看英文说中文、看中文写英文，两个方向都练。",
    });
  });

  app.post("/vocabulary/answer", async (c) => {
    const parsed = VocabAnswerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    const body = parsed.data;
    body.learnerId = effectiveLearnerId(c, state, body.learnerId) ?? body.learnerId;
    if (!state.repo.getLearner(body.learnerId)) return c.json({ error: "learner 不存在" }, 404);

    const card = cards().find((w) => w.id === body.wordId);
    if (!card) return c.json({ error: "没有这个单词" }, 404);

    const direction = body.direction ?? (card.id.charCodeAt(card.id.length - 1) % 2 === 0 ? "en2zh" : "zh2en");
    const verdict = judgeVocab(card, direction, body.answer);
    const progress =
      body.retry === true
        ? // 重答只看这次写对没有，不动排期
          null
        : recordVocabAnswer(state.repo, body.learnerId, card.id, verdict.correct);

    // 只记"答了什么词、对没对"，不把孩子的拼写原样存进事件里（词表卡不是判卷证据链）
    state.repo.appendEvent(body.learnerId, "vocab-answer", {
      wordId: card.id,
      direction,
      correct: verdict.correct,
      verification: "reference",
      ...(body.retry === true ? { retry: true } : {}),
    });

    return c.json({
      correct: verdict.correct,
      reference: verdict.reference,
      verification: "reference",
      progress,
      retry: body.retry === true,
      // 答错时给例句：词要放回句子里才记得住
      example: verdict.correct ? undefined : card.example,
    });
  });

  app.get("/reading/list", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);
    /*
     * 模块开关要在**每个**入口生效，不能只挡词汇。
     * 只挡一个的结果是：家长关掉了英语，孩子从阅读那条路照样学，
     * 而家长以为自己关上了——比没有开关更糟。
     */
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);

    const answered = new Map<string, Set<string>>();
    for (const event of state.repo.listEvents(learnerId, "reading-answer")) {
      const p = event.payload as { passageId?: string; questionId?: string; correct?: boolean };
      if (!p.passageId || !p.questionId || !p.correct) continue;
      const set = answered.get(p.passageId) ?? new Set<string>();
      set.add(p.questionId);
      answered.set(p.passageId, set);
    }

    return c.json({
      passages: reading.passages.map((p) => ({
        id: p.id,
        title: p.title,
        level: p.level,
        words: p.text.split(/\s+/).filter(Boolean).length,
        questionCount: p.questions.length,
        answered: answered.get(p.id)?.size ?? 0,
        done: (answered.get(p.id)?.size ?? 0) >= p.questions.length,
      })),
      dropped: reading.dropped,
    });
  });

  app.get("/reading/passage", (c) => {
    const id = c.req.query("id");
    if (!id) return c.json({ error: "需要 id" }, 400);
    const passage = reading.passages.find((p) => p.id === id);
    if (!passage) return c.json({ error: "没有这篇读物" }, 404);
    return c.json(publicPassage(passage));
  });

  app.post("/reading/answer", async (c) => {
    const parsed = ReadingAnswerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "参数错误" }, 400);
    const body = parsed.data;
    body.learnerId = effectiveLearnerId(c, state, body.learnerId) ?? body.learnerId;
    if (!state.repo.getLearner(body.learnerId)) return c.json({ error: "learner 不存在" }, 404);
    if (!moduleEnabled(state.repo, body.learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);

    const passage = reading.passages.find((p) => p.id === body.passageId);
    if (!passage) return c.json({ error: "没有这篇读物" }, 404);
    const question = passage.questions.find((q) => q.id === body.questionId);
    if (!question) return c.json({ error: "没有这道题" }, 404);

    const verdict = judgeReading(question, body.answer);
    state.repo.appendEvent(body.learnerId, "reading-answer", {
      passageId: passage.id,
      questionId: question.id,
      correct: verdict.correct,
      verification: "reference",
    });

    /*
     * 证据只在**答对之后**给。答错时直接亮原文那一句，等于把答案念出来；
     * 而答对后给，是把"你刚才凭直觉找到的东西"落成可复述的依据——
     * 这正是阅读要教的事：答案不是猜的，在原文里有位置。
     */
    return c.json({
      correct: verdict.correct,
      verification: "reference",
      ...(verdict.correct
        ? { reference: verdict.reference, evidence: question.evidence }
        : { hint: "再读一遍短文，答案就藏在某一句里。" }),
    });
  });

  return app;
}
