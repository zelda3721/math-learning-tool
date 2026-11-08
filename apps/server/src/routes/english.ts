import { Hono, type Context } from "hono";
import { z } from "zod";
import { effectiveLearnerId, type AppState } from "../app.js";
import { judgeVocab, loadVocabulary, recordVocabAnswer, vocabBatch, type VocabCard } from "../vocabulary.js";
import { judgeReading, loadReading, publicPassage } from "../reading.js";
import { moduleBlockedBody, moduleEnabled } from "../modules.js";
import { budgetBlockedPayload } from "../chatBudget.js";
import { isWav, synthesizeLongSpeech } from "../voice.js";
import { countWords, loadWriting, reviewWriting, writingPromptById } from "../writing.js";
import { screenLearnerInput, screenModelOutput } from "../safety.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { practiceReady } from "../questions.js";
import { effectiveP, masteryBand } from "../mastery.js";
import { loadEvidenceStats } from "../evidence.js";
import { revealsQuestion } from "../classroom/englishLesson.js";
import type { Question } from "@mathtutor/schema";

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

/** 听力同一题当天答错几次之后，第三次才给参考答案（和阅读"先提示、不直接给"的节奏一致） */
const LISTENING_REVEAL_AFTER = 2;

/** 本地时间的今天零点：和时长闸同一个"今天" */
function startOfLocalDay(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 英文分词：撇号缩写展开（She's → she is），数字也算词（"I'm 22." 里的 22 是上下文） */
function englishTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/n't\b/g, " not")
    .replace(/'re\b/g, " are")
    .replace(/'m\b/g, " am")
    .replace(/'s\b/g, " is")
    .replace(/'ve\b/g, " have")
    .replace(/'ll\b/g, " will")
    .replace(/'d\b/g, " would")
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

function containsRun(hay: string[], run: string[]): boolean {
  if (run.length === 0 || run.length > hay.length) return false;
  for (let i = 0; i + run.length <= hay.length; i++) {
    if (run.every((w, k) => hay[i + k] === w)) return true;
  }
  return false;
}

/**
 * 这句话是不是**直接把空填上了**：空左边那个词 + 答案、或者答案 + 空右边那个词，原样出现在句子里。
 *
 * revealsQuestion 判的是"是不是同一句话"（实词重合度），对短题干判不出来：
 * `It ___ (rain) now.` 和例句 `It's raining.` 只有一个实词重合；`I ___ 22 years old.`
 * 和 `I'm 22.` 一个实词都不重合——可孩子照着例句抄，空就填对了。
 * 这里看的是空两边的那个词和答案拼起来的那一小段，只拿来筛和题干同屏的教材原文。
 */
export function fillsBlank(sentence: string, question: Question): boolean {
  // 题干里冒号后面才是英文题面；括号里的提示词（eat / not like）不是句子的一部分
  const english = question.stem.split(/[：:]/).pop() ?? question.stem;
  const stemTokens = englishTokens(english.replace(/\([^)]*\)/g, " ").replace(/_{2,}/g, " ___ "));
  const blank = stemTokens.indexOf("___");
  if (blank === -1) return false;
  const left = stemTokens[blank - 1];
  const right = stemTokens[blank + 1];
  const hay = englishTokens(sentence);
  return String(question.answer)
    .split("/")
    .map((alt) => englishTokens(alt))
    .filter((alt) => alt.length > 0)
    .some(
      (alt) =>
        (left !== undefined && containsRun(hay, [left, ...alt])) ||
        (right !== undefined && containsRun(hay, [...alt, right])),
    );
}

/**
 * 把一段教材原文里**会泄露本单元任一下发题目**的句子去掉。
 *
 * 语法单元页把 summary / whatIsIt（教材原句）和题干摆在同一屏：
 * "My name is Lisa." 和 "My name ___ Lisa." 一上一下，孩子照抄就"答对"了，
 * 进掌握度的却是 reference 证据。判句子是不是同一句，用课堂那边同一把尺子
 * （revealsQuestion），不另造一套标准。
 */
export function redactRevealing(text: string | undefined, questions: Question[]): string | undefined {
  if (!text || questions.length === 0) return text;
  const sentences = text.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  const kept = sentences.filter(
    (sentence) => !questions.some((q) => revealsQuestion(sentence, q) || fillsBlank(sentence, q)),
  );
  return kept.length === sentences.length ? text : kept.join(" ");
}

export function englishRoutes(state: AppState): Hono {
  const app = new Hono();

  /**
   * 作答/读原文类入口的三道闸：learner 存在 + 英语模块开着 + 今天还有时长。
   * 词汇、写作、口语早就三道都过；阅读与听力作答漏了后两道，
   * 家长关掉英语或时长用完后，孩子从这两条路照样能学——闸就成了摆设。
   */
  const gate = (c: Context, learnerId: string | undefined): Response | undefined => {
    if (!learnerId) return c.json({ error: "需要 learnerId（孩子会话会自动带上）" }, 400);
    if (!state.repo.getLearner(learnerId)) return c.json({ error: "learner 不存在" }, 404);
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    const blocked = budgetBlockedPayload(state.repo, learnerId);
    if (blocked) return c.json(blocked, 429);
    return undefined;
  };

  /** 听力里已经被亮过参考答案的题（passageId/questionId）：阅读里再答对不算"读懂了" */
  const revealedInListening = (learnerId: string, passageId: string, questionId: string): boolean =>
    state.repo
      .listEvents(learnerId, "listening-answer")
      .some((e) => {
        const p = e.payload as { passageId?: string; questionId?: string; revealed?: boolean };
        return p.revealed === true && p.passageId === passageId && p.questionId === questionId;
      });

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

  /*
   * 语法单元：英语的第三条线，和词汇、阅读并列。
   *
   * 单元来自教材本身（grammar.graph.json，115 个单元，标题即语法点、顺序即学习顺序，
   * 每个节点带页码出处）。这里只做"有哪些单元、哪个有题可做"的目录，
   * 讲课走已有的课堂（en:grammar-* 节点），做题走已有的 /practice/submit——
   * 不再造第二条判卷通路。
   */
  app.get("/grammar/units", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    /*
     * 单元进度：孩子要能看见"练到哪儿了"。
     * 掌握度口径和星图一致（独立证据才算点亮），这里不另造一套。
     */
    const mastery = new Map(state.repo.allMastery(learnerId).map((m) => [m.nodeId, m]));
    const evidence = loadEvidenceStats(state.repo, state.questions, learnerId);
    const attempts = state.repo.attemptsForEvidence(learnerId);
    const practiced = new Map<string, { n: number; lastAt: string }>();
    for (const a of attempts) {
      const q = state.questions.byId.get(a.questionId);
      if (!q) continue;
      for (const nodeId of q.nodeIds) {
        if (!nodeId.startsWith("en:grammar-")) continue;
        const cur = practiced.get(nodeId) ?? { n: 0, lastAt: a.at };
        practiced.set(nodeId, { n: cur.n + 1, lastAt: a.at > cur.lastAt ? a.at : cur.lastAt });
      }
    }
    const units = state.knowledge.graph.nodes
      .filter((n) => n.id.startsWith("en:grammar-"))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((n) => {
        const row = mastery.get(n.id);
        const p = row ? effectiveP(row) : 0;
        const band = row ? masteryBand(p, row.evidenceN, evidence.get(n.id)) : "dim";
        const seen = practiced.get(n.id);
        return {
          id: n.id,
          name: n.name,
          stage: n.stage,
          order: n.order ?? 0,
          questionCount: (state.questions.byNode.get(n.id) ?? []).filter((q) => practiceReady(q)).length,
          // 一句话说清这单元要学什么（教材对照页里那句）
          summary: n.summary,
          // 进度：三档亮度 + 练过几次 + 最后一次
          band,
          practicedN: seen?.n ?? 0,
          lastPracticedAt: seen?.lastAt,
        };
      });
    return c.json({ units });
  });

  /** 一个语法单元：讲解入口 + 可练的题（题面下发，答案不下发） */
  app.get("/grammar/unit/:id", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    const node = state.knowledge.index.getNode(c.req.param("id"));
    if (!node || !node.id.startsWith("en:grammar-")) return c.json({ error: "没有这个语法单元" }, 404);
    const questions = (state.questions.byNode.get(node.id) ?? []).filter((q) => practiceReady(q)).slice(0, 8);
    const row = state.repo.getMastery(learnerId, node.id);
    const stats = loadEvidenceStats(state.repo, state.questions, learnerId).get(node.id);
    return c.json({
      unit: {
        id: node.id,
        name: node.name,
        stage: node.stage,
        // 和题干同屏：会泄题的教材原句不下发（见 redactRevealing）
        summary: redactRevealing(node.summary, questions) ?? "",
        whatIsIt: redactRevealing(node.whatIsIt, questions),
        band: row ? masteryBand(effectiveP(row), row.evidenceN, stats) : "dim",
        evidenceN: row?.evidenceN ?? 0,
      },
      questions: questions.map((q) => ({
        id: q.id,
        stem: q.stem,
        options: q.options,
        answerType: q.answerType,
      })),
      // 课堂能不能开这节课（没材料时如实说，而不是给一个点不动的按钮）
      lessonAvailable: Boolean(state.knowledge.index.getNode(node.id)),
    });
  });

  /*
   * 听力（阶段 5）：**用 TTS 把短文念出来，短文本身不下发**。
   *
   * 这就是听力与阅读的全部区别：阅读把原文摆在眼前，听力只给声音。
   * 所以这一组接口刻意不回 text —— 回了就成了"看着原文做听力题"。
   * 音频按篇缓存到磁盘：同一篇念一次就够，重复合成既慢又浪费。
   */
  const listeningDir = () => path.join(state.config.dataDir, "listening");

  app.get("/listening/list", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    const passages = loadReading().passages.map((p) => ({
      id: p.id,
      title: p.title,
      level: p.level,
      questionCount: p.questions.length,
      // 已经听过几道题：听过与答对是两件事，这里只报"碰过"
      cached: existsSync(path.join(listeningDir(), `${p.id}.wav`)),
    }));
    return c.json({ passages });
  });

  app.get("/listening/passage/:id", async (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    const blocked = budgetBlockedPayload(state.repo, learnerId);
    if (blocked) return c.json(blocked, 429);
    const passage = loadReading().passages.find((p) => p.id === c.req.param("id"));
    if (!passage) return c.json({ error: "没有这篇听力材料" }, 404);

    const file = path.join(listeningDir(), `${passage.id}.wav`);
    let audio: string | null = null;
    // 旧缓存里可能躺着一份不是 wav 的"音频"（早先没校验就写了）：不认它，重新合成
    const cached = existsSync(file) ? readFileSync(file) : null;
    if (cached && isWav(cached)) {
      audio = cached.toString("base64");
    } else {
      const made = await synthesizeLongSpeech(state, passage.text);
      // 只缓存校验过的 wav：缓存一份坏音频，这篇听力就永远没声了
      if (made && isWav(Buffer.from(made.base64, "base64"))) {
        mkdirSync(listeningDir(), { recursive: true });
        writeFileSync(file, Buffer.from(made.base64, "base64"));
        audio = made.base64;
      }
    }
    return c.json({
      id: passage.id,
      title: passage.title,
      level: passage.level,
      audio,
      // 没有语音后端就诚实说，并把这次听力当成"现在做不了"，不偷偷把原文给出去
      ttsAvailable: audio !== null,
      questions: passage.questions.map((q) => ({ id: q.id, prompt: q.prompt })),
      note: audio
        ? "听两遍，再答题。没听清就重听，不用急着作答。"
        : "这台机器上还没有语音合成，听力暂时做不了。",
    });
  });

  app.post("/listening/answer", async (c) => {
    const parsed = z
      .object({ learnerId: z.string().optional(), passageId: z.string().min(1), questionId: z.string().min(1), answer: z.string().max(200) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    const closed = gate(c, learnerId);
    if (closed || !learnerId) return closed!;
    const passage = loadReading().passages.find((p) => p.id === parsed.data.passageId);
    const question = passage?.questions.find((q) => q.id === parsed.data.questionId);
    if (!passage || !question) return c.json({ error: "没有这道听力题" }, 404);
    const verdict = judgeReading(question, parsed.data.answer);

    /*
     * 答错不给参考答案、也不给原文那一句——听力材料和阅读是同一批短文，
     * 原文句一亮，等于把听力变成了阅读、把答案念给孩子听。
     * 同一题今天已经错过 LISTENING_REVEAL_AFTER 次，这一次（第三次）还错才给参考答案：
     * 再卡下去没有学习价值，只剩挫败。亮过答案的题要在事件里标出来，
     * 阅读那边据此不把"抄来的对"算成读懂了。
     */
    const since = startOfLocalDay();
    const wrongToday = state.repo.listEvents(learnerId, "listening-answer").filter((e) => {
      const p = e.payload as { passageId?: string; questionId?: string; correct?: boolean };
      return (
        p.passageId === passage.id &&
        p.questionId === question.id &&
        p.correct === false &&
        new Date(e.ts).getTime() >= since
      );
    }).length;
    const reveal = !verdict.correct && wrongToday >= LISTENING_REVEAL_AFTER;
    // 听力作答留痕：不留孩子写的原文，只留对错与是否亮过答案
    state.repo.appendEvent(learnerId, "listening-answer", {
      passageId: passage.id,
      questionId: question.id,
      correct: verdict.correct,
      ...(reveal ? { revealed: true } : {}),
      verification: "reference",
    });
    if (verdict.correct) return c.json({ correct: true, evidence: question.evidence });
    // 第三次还错：只给参考答案。原文那一句不给——同一篇里它可能顺带答了别的题
    if (reveal) return c.json({ correct: false, retry: false, reference: question.answer });
    return c.json({ correct: false, retry: true });
  });

  /*
   * 写作（阶段 5）：给任务 → 孩子写 → 按量规给反馈。
   *
   * 一律 `ai_unverified`：不进掌握度、不点亮星（PLAN D9）。界面必须说出来，
   * 否则"AI 说不错"会被当成"我会了"。
   */
  app.get("/writing/prompts", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    return c.json({
      prompts: loadWriting().map((p) => ({
        id: p.id,
        title: p.title,
        level: p.level,
        prompt: p.prompt,
        minWords: p.minWords,
        mustUse: p.mustUse,
        tips: p.tips,
      })),
    });
  });

  app.post("/writing/submit", async (c) => {
    const parsed = z
      .object({ learnerId: z.string().optional(), promptId: z.string().min(1), text: z.string().min(1).max(2000) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId || !state.repo.getLearner(learnerId)) {
      return c.json({ error: "需要 learnerId（孩子会话会自动带上）" }, 404);
    }
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    const blocked = budgetBlockedPayload(state.repo, learnerId);
    if (blocked) return c.json(blocked, 429);
    const task = writingPromptById(parsed.data.promptId);
    if (!task) return c.json({ error: "没有这个写作任务" }, 404);

    // 孩子写的内容也要过安检（它会进模型，也会被家长看到）
    const screen = screenLearnerInput(state.repo, learnerId, parsed.data.text);
    if (screen.blocked) return c.json({ error: screen.reply }, 422);

    // 反馈要说给孩子听：tip / praise 各过一遍输出侧安检（拦下即换固定话术，见 guardFeedbackLine）
    const feedback = await reviewWriting(state.hintProvider, task, parsed.data.text, {
      screen: (line) => screenModelOutput(state.repo, learnerId, line).blocked,
    });
    state.repo.appendEvent(learnerId, "writing", {
      promptId: task.id,
      words: countWords(parsed.data.text),
      // 只留统计，不留全文：作文全文属于孩子的隐私，家长要看应该由孩子自己拿给他看
      bands: feedback?.bands ?? null,
      inconsistent: feedback?.inconsistent ?? null,
      mustUseMissing: feedback?.requirements.mustUseMissing.length ?? null,
      belowMinWords: feedback?.requirements.belowMinWords ?? null,
      verification: "ai_unverified",
    });
    if (!feedback) {
      return c.json(
        {
          error: "现在没有可用的模型，写作反馈暂时给不了。可以先检查一遍时态和拼写。",
          words: countWords(parsed.data.text),
        },
        503,
      );
    }
    return c.json({ ...feedback, verification: "ai_unverified", countedTowardMastery: false });
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
      const p = event.payload as { passageId?: string; questionId?: string; correct?: boolean; afterReveal?: boolean };
      // 听力里看过答案之后的"对"不算读懂（见 /reading/answer）
      if (!p.passageId || !p.questionId || !p.correct || p.afterReveal) continue;
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
    // 下发原文也是学习：早先这里谁都能拿、不看模块不看时长，家长关了英语照样读得到
    const closed = gate(c, effectiveLearnerId(c, state, c.req.query("learnerId")));
    if (closed) return closed;
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
    const closed = gate(c, body.learnerId);
    if (closed) return closed;

    const passage = reading.passages.find((p) => p.id === body.passageId);
    if (!passage) return c.json({ error: "没有这篇读物" }, 404);
    const question = passage.questions.find((q) => q.id === body.questionId);
    if (!question) return c.json({ error: "没有这道题" }, 404);

    const verdict = judgeReading(question, body.answer);
    /*
     * 同一批短文也是听力材料。听力里已经亮过这道题的参考答案，
     * 阅读里再答对就只是"记住了答案"，不能把这一篇算成读完（done）。
     * 判卷照常说对，事件里标 afterReveal，列表统计跳过它。
     */
    const afterReveal = verdict.correct && revealedInListening(body.learnerId, passage.id, question.id);
    state.repo.appendEvent(body.learnerId, "reading-answer", {
      passageId: passage.id,
      questionId: question.id,
      correct: verdict.correct,
      ...(afterReveal ? { afterReveal: true } : {}),
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
        ? { reference: verdict.reference, evidence: question.evidence, counted: !afterReveal }
        : { hint: "再读一遍短文，答案就藏在某一句里。" }),
    });
  });

  return app;
}
