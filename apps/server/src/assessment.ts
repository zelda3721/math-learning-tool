import type { Question } from "@mathtutor/schema";
import type { QuestionStore } from "./questions.js";
import { isEnglishNodeId, practiceReady } from "./questions.js";
import type { Repo } from "./repo.js";
import { judgeVocab, vocabCardsOf, type VocabCard } from "./vocabulary.js";
import { judgeReading, type LoadedReading, type ReadingPassage } from "./reading.js";

/**
 * 阶段测评：前测 / 后测 / 保持率（PLAN 第七部分那条"贯穿全程"的要求）。
 *
 * 为什么必须先有骨架：PLAN 写着"只有数据证明 AI 原生方式比单纯刷题更有效，才算完成"。
 * 没有前测，就没有"起点"；没有后测和保持率，就没有"学会了还是记住了"。
 *
 * 三条口径，都是为了别把测量变成装饰：
 * 1. **不碰掌握度**。测评单独记账（assessments / assessment_items），
 *    一旦往掌握度里写，测评就改变了它所测量的东西。
 * 2. **只用没见过的题**。练习做过的、**任何一次测评里出现过的**都算见过——
 *    前测交卷时已经给了参考答案，后测再发同一道，测的就是"记没记住答案"。
 *    题不够时如实标注 `reused`，不假装是新题。
 * 3. **不给提示**。测评里没有提示阶梯，答不出来就是答不出来。
 *
 * 再加一条可比性：后测与保持率**沿用前测的 scope**（同一批节点、同样题量）。
 * 各自另挑节点的话，"前测 40% → 后测 70%"可能只是换了一批更容易的节点。
 */

export type AssessmentKind = "pre" | "post" | "retention";

export const ASSESSMENT_KINDS: AssessmentKind[] = ["pre", "post", "retention"];

/** 测评按学科分开记：数学的前测和英语的后测放一起比，没有意义 */
export type AssessmentSubject = "math" | "english";

export const ASSESSMENT_SUBJECTS: AssessmentSubject[] = ["math", "english"];

/**
 * 英语测评的"节点"：词汇与阅读不是图谱节点（见 vocabulary.ts 第 2 条），
 * 这里用两个固定的伪节点承载 byNode 统计，前缀 `english:` 也是判断学科的依据。
 */
export const ENGLISH_SCOPE = ["english:vocab", "english:reading"] as const;

/** 英语测评题量：6 个词（英→中）+ 每篇阅读 1 题、最多 4 篇 */
export const ENGLISH_VOCAB_COUNT = 6;
export const ENGLISH_READING_PASSAGES = 4;

/** 后测在 7 天后，保持率在 28 天后——间隔太短测的是记忆，太长测的是遗忘 */
export const ASSESSMENT_SCHEDULE = { postAfterDays: 7, retentionAfterDays: 28 } as const;

/** 读全部测评时的上限：家庭场景一个孩子一年也就十几份，取大一点免得漏算"见过" */
const ALL_ASSESSMENTS = 500;

/** pending 判卷的留痕事件：新库判不准直接存 NULL；旧库当年写成了 0，靠它还原 */
export const ASSESSMENT_PENDING_EVENT = "assessment_item_pending";

export interface BuiltAssessment {
  scope: string[];
  questions: Question[];
  /** 题库里没那么多没见过的题，用了见过的题来凑（如实标注） */
  reused: boolean;
}

const DAY = 86_400_000;

/** 一份测评属于哪个学科：英语测评的 scope 全是 `english:` 伪节点 */
export function assessmentSubjectOf(a: { scope: string[] }): AssessmentSubject {
  return a.scope.some((s) => s.startsWith("english:")) ? "english" : "math";
}

/** 这个孩子所有测评（含没交卷的）里出现过的题 id——开卷那一刻题面就已经给他看了 */
export function assessedQuestionIds(repo: Repo, learnerId: string): Set<string> {
  const out = new Set<string>();
  for (const a of repo.listAssessments(learnerId, ALL_ASSESSMENTS)) {
    for (const item of repo.listAssessmentItems(a.id)) out.add(item.questionId);
  }
  return out;
}

/**
 * 每道题在测评里"第一次被见到"的时间（供 evidence 计算首见时用）。
 *
 * 为什么不只看 answered_at：开卷时整份题都下发了，没作答的题孩子也看过题面，
 * 交卷时还看到了参考答案。所以作答过的取 answered_at，没作答的退到测评创建时间。
 * 同一道题出现在多份测评里时取最早的那次。
 */
export function assessmentSeenAt(repo: Repo, learnerId: string): Map<string, string> {
  // 一条聚合 SQL：证据统计每次提交都要读它，逐份测评逐题读太慢
  return repo.assessmentSeenAt(learnerId);
}

/** 最近一次**交过卷**的某档测评（按学科） */
export function latestFinishedAssessment(
  repo: Repo,
  learnerId: string,
  kind: AssessmentKind,
  subject: AssessmentSubject = "math",
): { id: string; kind: string; scope: string[]; createdAt: string; finishedAt: string | null } | undefined {
  return repo
    .listAssessments(learnerId, ALL_ASSESSMENTS)
    .filter((a) => a.finishedAt && a.kind === kind && assessmentSubjectOf(a) === subject)
    .sort((a, b) => (a.finishedAt! < b.finishedAt! ? 1 : -1))[0];
}

/**
 * 分层挑题：先保证每组（节点）有一道——挑该组里"最没见过"的那道；
 * 再按组轮转补满，补的时候先用完全没见过的，再用练习里做过的，最后才用测评里出现过的
 * （那些交卷时已经看过参考答案）。同一题只会被挑一次——一道题挂在两个节点上时，
 * 曾经会在一份卷子里出现两次。
 */
function pickTiered<T>(
  groups: T[][],
  idOf: (t: T) => string,
  tierOf: (t: T) => 0 | 1 | 2,
  count: number,
): { picked: T[]; reused: boolean } {
  const picked: T[] = [];
  const chosen = new Set<string>();
  const take = (t: T) => {
    picked.push(t);
    chosen.add(idOf(t));
  };
  // 第一轮：覆盖面优先，一组一道
  for (const group of groups) {
    if (picked.length >= count) break;
    for (const tier of [0, 1, 2] as const) {
      const hit = group.find((t) => tierOf(t) === tier && !chosen.has(idOf(t)));
      if (hit) {
        take(hit);
        break;
      }
    }
  }
  // 之后按层、按组轮转补满
  for (const tier of [0, 1, 2] as const) {
    let progressed = true;
    while (picked.length < count && progressed) {
      progressed = false;
      for (const group of groups) {
        if (picked.length >= count) break;
        const next = group.find((t) => tierOf(t) === tier && !chosen.has(idOf(t)));
        if (!next) continue;
        take(next);
        progressed = true;
      }
    }
  }
  return { picked, reused: picked.some((t) => tierOf(t) > 0) };
}

/**
 * 挑题（数学）：沿 scope 的节点，一节点一道、优先没见过的题。
 *
 * scope 来源：
 * - 后测 / 保持率：**沿用最近一次前测的 scope 与题量**——这是前后可比的前提；
 * - 前测：缺省用"孩子练过的节点"（掌握度最低的优先）；一个都没练过（新孩子）
 *   就从本学段有题的节点里取——前测的意义本来就是"还不知道他会什么"。
 *
 * "见过"= 练习做过 ∪ 任何一次测评里出现过。缺图的题（store.figureMissing）不选：
 * 看不到图的几何题，答不出来测的是"图丢了"，不是"会不会"。
 */
export function buildAssessment(
  store: QuestionStore,
  repo: Repo,
  learnerId: string,
  opts: { kind: AssessmentKind; scope?: string[]; count?: number },
): BuiltAssessment {
  const pre = opts.kind === "pre" ? undefined : latestFinishedAssessment(repo, learnerId, "pre", "math");
  const preCount = pre ? repo.listAssessmentItems(pre.id).length : undefined;
  const count = Math.min(Math.max(opts.count ?? preCount ?? 8, 4), 12);
  const attempted = repo.attemptedQuestionIds(learnerId);
  const assessed = assessedQuestionIds(repo, learnerId);
  // 数学测评只取数学节点：英语语法题和数学题共用题库与掌握度表，不筛会把语法题混进数学卷
  const mastery = repo.allMastery(learnerId).filter((m) => m.evidenceN > 0 && !isEnglishNodeId(m.nodeId));

  const inheritedScope = pre && pre.scope.length > 0 ? pre.scope : undefined;
  const scope =
    opts.scope && opts.scope.length > 0
      ? opts.scope
      : inheritedScope
        ? inheritedScope
        : mastery.length > 0
          ? mastery.sort((a, b) => a.p - b.p).slice(0, count).map((m) => m.nodeId)
          : [];

  const nodesWithQuestions =
    scope.length > 0
      ? scope
      : [...store.byNode.keys()]
          .filter((id) => !isEnglishNodeId(id) && (store.byNode.get(id) ?? []).length > 0)
          .slice(0, count);

  const usable = (q: Question) => practiceReady(q) && !store.figureMissing.has(q.id);
  const groups = nodesWithQuestions.map((nodeId) => (store.byNode.get(nodeId) ?? []).filter(usable));
  // 0 = 没见过；1 = 练习做过；2 = 测评里出现过（交卷时已经看过参考答案，最后才用）
  const tierOf = (q: Question): 0 | 1 | 2 => (assessed.has(q.id) ? 2 : attempted.has(q.id) ? 1 : 0);
  const { picked, reused } = pickTiered(groups, (q) => q.id, tierOf, count);

  // 沿用来的 scope 原样保留：节点这次没抽到题，对比时自然不出现，但不能悄悄换掉口径
  const outScope = inheritedScope && !(opts.scope && opts.scope.length > 0)
    ? inheritedScope
    : nodesWithQuestions.filter((id) => picked.some((q) => q.nodeIds.includes(id)));
  return { scope: outScope, questions: picked, reused };
}

/** 英语测评下发给孩子的题目视图（不含答案） */
export interface EnglishAssessmentItem {
  id: string;
  stem: string;
  stemEn?: string;
  answerType: "text";
  answerLang: "zh" | "en";
  nodeIds: string[];
  /** 阅读题带原文：阅读测的是"从原文里找"，不给原文就成了听力 */
  passage?: { id: string; title: string; level: string; text: string };
}

export interface BuiltEnglishAssessment {
  scope: string[];
  items: EnglishAssessmentItem[];
  reused: boolean;
}

const vocabItemId = (wordId: string) => `vocab:${wordId}`;
const readingItemId = (passageId: string, questionId: string) => `reading:${passageId}:${questionId}`;

/** 解析英语测评题 id；不是英语题返回 null */
export function parseEnglishItemId(
  id: string,
): { kind: "vocab"; wordId: string } | { kind: "reading"; passageId: string; questionId: string } | null {
  if (id.startsWith("vocab:")) return { kind: "vocab", wordId: id.slice("vocab:".length) };
  if (id.startsWith("reading:")) {
    const rest = id.slice("reading:".length);
    const cut = rest.lastIndexOf(":");
    if (cut <= 0) return null;
    return { kind: "reading", passageId: rest.slice(0, cut), questionId: rest.slice(cut + 1) };
  }
  return null;
}

function vocabView(card: VocabCard): EnglishAssessmentItem {
  return {
    id: vocabItemId(card.id),
    stem: `“${card.en}” 是什么意思？用中文写出来。`,
    stemEn: card.en,
    answerType: "text",
    answerLang: "zh",
    nodeIds: [ENGLISH_SCOPE[0]],
  };
}

function readingView(passage: ReadingPassage, q: ReadingPassage["questions"][number]): EnglishAssessmentItem {
  return {
    id: readingItemId(passage.id, q.id),
    stem: q.prompt,
    stemEn: q.prompt,
    answerType: "text",
    answerLang: "en",
    nodeIds: [ENGLISH_SCOPE[1]],
    passage: { id: passage.id, title: passage.title, level: passage.level, text: passage.text },
  };
}

/**
 * 挑题（英语）：词汇 6 个（英→中）+ 阅读每篇 1 题。
 *
 * 词：学过的（有复习卡）最多一半，其余按词表顺序取还没学的——前测时基本都没学过，
 * 正好就是他接下来要学的那批；后测时一半学过、一半没学过，学没学的差别一眼可比。
 * 阅读：每篇挑一道没见过的；练习里答过的、测评里出现过的往后放，用了就标 reused。
 */
export function buildEnglishAssessment(
  repo: Repo,
  learnerId: string,
  vocabulary: VocabCard[],
  reading: LoadedReading,
): BuiltEnglishAssessment {
  const assessed = assessedQuestionIds(repo, learnerId);
  const progress = vocabCardsOf(repo, learnerId);

  const fresh = vocabulary.filter((c) => !assessed.has(vocabItemId(c.id)));
  const learned = fresh.filter((c) => progress.has(c.id));
  const unlearned = fresh.filter((c) => !progress.has(c.id));
  const words: VocabCard[] = learned.slice(0, Math.floor(ENGLISH_VOCAB_COUNT / 2));
  for (const c of [...unlearned, ...learned]) {
    if (words.length >= ENGLISH_VOCAB_COUNT) break;
    if (!words.includes(c)) words.push(c);
  }
  let reused = false;
  // 新词用完了才回头用测评里考过的词（如实标注）
  for (const c of vocabulary) {
    if (words.length >= ENGLISH_VOCAB_COUNT) break;
    if (words.includes(c)) continue;
    words.push(c);
    reused = true;
  }

  const practiced = new Set<string>();
  for (const event of repo.listEvents(learnerId, "reading-answer")) {
    const p = event.payload as { passageId?: string; questionId?: string };
    if (p.passageId && p.questionId) practiced.add(readingItemId(p.passageId, p.questionId));
  }
  // 听力和阅读共用短文和题：听力里答过（尤其是已经亮过参考答案）的题，也不是"没见过"
  for (const event of repo.listEvents(learnerId, "listening-answer")) {
    const p = event.payload as { passageId?: string; questionId?: string };
    if (p.passageId && p.questionId) practiced.add(readingItemId(p.passageId, p.questionId));
  }
  const groups = reading.passages
    .slice(0, ENGLISH_READING_PASSAGES)
    .map((passage) => passage.questions.map((q) => ({ passage, q, id: readingItemId(passage.id, q.id) })));
  const tierOf = (x: { id: string }): 0 | 1 | 2 => (assessed.has(x.id) ? 2 : practiced.has(x.id) ? 1 : 0);
  // 每篇只要一道：题量 = 篇数，分层挑题的第一轮正好一篇一道（挑该篇"最没见过"的那道）
  const readingPicked = pickTiered(groups, (x) => x.id, tierOf, groups.filter((g) => g.length > 0).length);
  const readingPicks = readingPicked.picked;
  if (readingPicked.reused) reused = true;

  const items = [...words.map(vocabView), ...readingPicks.map((x) => readingView(x.passage, x.q))];
  return { scope: [...ENGLISH_SCOPE], items, reused };
}

/** 判一道英语测评题；题不存在（词表/读物改了）返回 null */
export function judgeEnglishItem(
  id: string,
  answer: string,
  vocabulary: VocabCard[],
  reading: LoadedReading,
): { correct: boolean; reference: string } | null {
  const parsed = parseEnglishItemId(id);
  if (!parsed) return null;
  if (parsed.kind === "vocab") {
    const card = vocabulary.find((c) => c.id === parsed.wordId);
    return card ? judgeVocab(card, "en2zh", answer) : null;
  }
  const q = reading.passages.find((p) => p.id === parsed.passageId)?.questions.find((x) => x.id === parsed.questionId);
  return q ? judgeReading(q, answer) : null;
}

/** 英语测评题的参考答案（交卷时给） */
export function englishReference(id: string, vocabulary: VocabCard[], reading: LoadedReading): string {
  const parsed = parseEnglishItemId(id);
  if (!parsed) return "";
  if (parsed.kind === "vocab") return vocabulary.find((c) => c.id === parsed.wordId)?.zh ?? "";
  return (
    reading.passages.find((p) => p.id === parsed.passageId)?.questions.find((x) => x.id === parsed.questionId)?.answer ?? ""
  );
}

/** 按存下来的题 id 还原下发视图（续做一份没交卷的英语测评时用）；题已不存在返回 null */
export function englishItemView(id: string, vocabulary: VocabCard[], reading: LoadedReading): EnglishAssessmentItem | null {
  const parsed = parseEnglishItemId(id);
  if (!parsed) return null;
  if (parsed.kind === "vocab") {
    const card = vocabulary.find((c) => c.id === parsed.wordId);
    return card ? vocabView(card) : null;
  }
  const passage = reading.passages.find((p) => p.id === parsed.passageId);
  const q = passage?.questions.find((x) => x.id === parsed.questionId);
  return passage && q ? readingView(passage, q) : null;
}

/** 英语测评题落在哪个伪节点 */
export function englishNodeIdsOf(id: string): string[] {
  const parsed = parseEnglishItemId(id);
  if (!parsed) return [];
  return [parsed.kind === "vocab" ? ENGLISH_SCOPE[0] : ENGLISH_SCOPE[1]];
}

/**
 * 读一份测评的作答，把"判不准"的题还原成 correct=null。
 *
 * 现在判不准直接存 NULL；早先的库判不准写成了 0，另记过一条 ASSESSMENT_PENDING_EVENT，这里叠回去：
 * 判不准既不算对也不算错，不能拿"没判卷器"冒充"孩子答错了"。
 */
export function assessmentItemsOf(
  repo: Repo,
  learnerId: string,
  assessmentId: string,
): { questionId: string; answer: string | null; answeredAt: string | null; correct: boolean | null; pending: boolean }[] {
  const pending = new Set<string>();
  for (const event of repo.listEvents(learnerId, ASSESSMENT_PENDING_EVENT)) {
    const p = event.payload as { assessmentId?: string; questionId?: string };
    if (p.assessmentId === assessmentId && p.questionId) pending.add(p.questionId);
  }
  return repo.listAssessmentItems(assessmentId).map((i) => {
    // 判不准：新库直接存 NULL；旧库存的是 0，靠留痕事件还原
    const isPending = i.answeredAt !== null && (i.correct === null || pending.has(i.questionId));
    return {
      questionId: i.questionId,
      answer: i.answer,
      answeredAt: i.answeredAt,
      correct: isPending ? null : i.correct,
      pending: isPending,
    };
  });
}

export interface AssessmentSuggestion {
  kind: AssessmentKind;
  /** 为什么现在该做这一份 */
  why: string;
  /** 还没到时间时给一句"什么时候再来" */
  dueAt?: string;
}

/**
 * 下一份测什么：没有前测先做前测；做过前测满 7 天做后测；做过后测满 28 天做保持率。
 * 同一档只做一次——重复做会把"测评"变成"刷测评"，数字立刻失真。
 * 按学科分开排期：数学做过前测，不影响英语从前测开始。
 */
export function nextAssessment(
  repo: Repo,
  learnerId: string,
  now = new Date(),
  subject: AssessmentSubject = "math",
): AssessmentSuggestion | null {
  const latest = (kind: AssessmentKind) => latestFinishedAssessment(repo, learnerId, kind, subject);

  const pre = latest("pre");
  if (!pre) {
    return { kind: "pre", why: "先做一次前测：之后才说得清这段时间学到了什么。" };
  }
  const post = latest("post");
  const days = (from: string) => (now.getTime() - Date.parse(from)) / DAY;

  if (!post) {
    const due = days(pre.finishedAt!) >= ASSESSMENT_SCHEDULE.postAfterDays;
    if (due) return { kind: "post", why: "离前测已经过去一周，做一次后测看看学到哪儿了。" };
    return {
      kind: "post",
      why: "后测安排在前测一周后。",
      dueAt: new Date(Date.parse(pre.finishedAt!) + ASSESSMENT_SCHEDULE.postAfterDays * DAY).toISOString(),
    };
  }
  const retention = latest("retention");
  if (!retention) {
    const due = days(post.finishedAt!) >= ASSESSMENT_SCHEDULE.retentionAfterDays;
    if (due) return { kind: "retention", why: "离后测过去四周了，看看当时会的现在还记不记得。" };
    return {
      kind: "retention",
      why: "保持率检查安排在后测四周后。",
      dueAt: new Date(Date.parse(post.finishedAt!) + ASSESSMENT_SCHEDULE.retentionAfterDays * DAY).toISOString(),
    };
  }
  return null;
}

export interface AssessmentResult {
  id: string;
  kind: AssessmentKind;
  /** 判得出对错的题数（统计分母）；判不准的不在里面 */
  answered: number;
  total: number;
  correct: number;
  /** 作答了但判不准（没有判卷器）的题数：单列出来，不算对也不算错 */
  pending: number;
  /** 交卷时没答的题数：算进分母、按没答对算（不然跳过难题就能刷高正确率，前后测也不在同一批题上比） */
  skipped: number;
  /** 0..1 = 对的 / (判得出的 + 没答的)；一道都没有返回 null（不拿 0 冒充"全错"） */
  rate: number | null;
  byNode: { nodeId: string; correct: number; total: number }[];
  items: { questionId: string; correct: boolean | null; reference: string }[];
}

/** 交卷统计（确定性；不调模型） */
export function summarizeAssessment(
  assessment: { id: string; kind: string; scope: string[] },
  items: { questionId: string; correct: boolean | null; pending?: boolean; answeredAt?: string | null }[],
  referenceOf: (questionId: string) => string,
  nodeIdsOf: (questionId: string) => string[],
): AssessmentResult {
  const answered = items.filter((i) => i.correct !== null);
  const correct = answered.filter((i) => i.correct).length;
  // 没答的：调用方给了 answeredAt 就按它认；没给按「没对错、也不是判不准」认
  const isSkipped = (i: (typeof items)[number]) =>
    i.answeredAt !== undefined ? i.answeredAt === null : i.correct === null && !i.pending;
  const skipped = items.filter(isSkipped);
  const counted = [...answered, ...skipped];
  const byNode = new Map<string, { correct: number; total: number }>();
  for (const item of counted) {
    for (const nodeId of nodeIdsOf(item.questionId)) {
      if (!assessment.scope.includes(nodeId)) continue;
      const cur = byNode.get(nodeId) ?? { correct: 0, total: 0 };
      cur.total += 1;
      if (item.correct) cur.correct += 1;
      byNode.set(nodeId, cur);
    }
  }
  return {
    id: assessment.id,
    kind: assessment.kind as AssessmentKind,
    answered: answered.length,
    total: items.length,
    correct,
    pending: items.filter((i) => i.pending && i.correct === null).length,
    skipped: skipped.length,
    rate: counted.length > 0 ? correct / counted.length : null,
    byNode: [...byNode.entries()].map(([nodeId, v]) => ({ nodeId, ...v })),
    items: items.map((i) => ({ questionId: i.questionId, correct: i.correct, reference: referenceOf(i.questionId) })),
  };
}

/**
 * 前测 → 后测 → 保持率：同一批节点上的对比。
 *
 * 只比**两次都覆盖到的节点**：后测换了题，没覆盖到的节点谈不上变化。
 */
export function compareAssessments(
  before: { kind: string; byNode: { nodeId: string; correct: number; total: number }[] },
  after: { kind: string; byNode: { nodeId: string; correct: number; total: number }[] },
): {
  before: string;
  after: string;
  nodes: { nodeId: string; beforeRate: number; afterRate: number; delta: number }[];
  overall: { beforeRate: number | null; afterRate: number | null };
} {
  const rateOf = (v: { correct: number; total: number }) => (v.total > 0 ? v.correct / v.total : 0);
  const beforeMap = new Map(before.byNode.map((n) => [n.nodeId, n]));
  const nodes = after.byNode
    .filter((n) => beforeMap.has(n.nodeId))
    .map((n) => {
      const b = beforeMap.get(n.nodeId)!;
      return { nodeId: n.nodeId, beforeRate: rateOf(b), afterRate: rateOf(n), delta: rateOf(n) - rateOf(b) };
    });
  const sum = (list: { correct: number; total: number }[]) => {
    const total = list.reduce((n, v) => n + v.total, 0);
    return total > 0 ? list.reduce((n, v) => n + v.correct, 0) / total : null;
  };
  return {
    before: before.kind,
    after: after.kind,
    nodes,
    overall: {
      beforeRate: sum(before.byNode.filter((n) => after.byNode.some((a) => a.nodeId === n.nodeId))),
      afterRate: sum(after.byNode.filter((n) => beforeMap.has(n.nodeId))),
    },
  };
}
