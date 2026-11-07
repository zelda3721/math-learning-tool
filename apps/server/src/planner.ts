import type { GraphIndex } from "@mathtutor/knowledge";
import type { QuestionStore } from "./questions.js";
import { practiceReady } from "./questions.js";
import type { Repo } from "./repo.js";

/**
 * 每日规划器：在时长预算里决定"今天做什么"。
 *
 * 三条决定：
 *
 * 1. **确定性，不调模型**。规划是每天都要跑一次的东西，模型一句话不稳、
 *    一天就乱了；而"先复习到期的、再学新的、剩下做题"本来就是可以写死的规则。
 * 2. **预算先给复习**。SM-2 的复习卡过期越久越难捡回来，新课晚一天没有代价。
 * 3. **没内容的档不占位**。口语、项目这些还没上线的档直接不出现——
 *    给孩子一个点了没反应的计划，比没有计划更糟。
 *
 * 返回的是"块"而不是"分钟数"：孩子要看到的是"复习 3 张卡、上一节分数课、做 6 道题"，
 * 不是"今天用 20 分钟"。
 */

export type PlanBlockKind = "review" | "lesson" | "english" | "practice" | "explore";

export interface PlanBlock {
  kind: PlanBlockKind;
  minutes: number;
  title: string;
  reason: string;
  /** 有明确对象的块带上它（复习=节点，新课=课堂节点） */
  nodeId?: string;
  subject?: string;
}

export interface DailyPlan {
  blocks: PlanBlock[];
  totalMinutes: number;
  leftMinutes: number;
  /** 预算不够时如实说明砍掉了什么，别让孩子以为"今天只有这些" */
  note?: string;
}

/** 每张复习卡按这个时长估：一张卡 1 道题 + 看一遍思路 */
const MINUTES_PER_REVIEW = 3;
const MINUTES_PER_LESSON = 8;
const MINUTES_PER_EXPLORE = 5;
/** 一次英语练习（几个词或一篇短文）的估计时长 */
const MINUTES_PER_ENGLISH = 6;
/** 至少留这么多给练习，否则这节课就只有复习、没有新东西 */
const MIN_PRACTICE_MINUTES = 4;

export function planToday(args: {
  repo: Repo;
  index: GraphIndex;
  store: QuestionStore;
  learnerId: string;
  /** 今天还剩多少分钟（时长闸算出来的，不是上限） */
  budgetMinutes: number;
  /**
   * 英语那边今天有多少活（到期词 + 新词）。
   * 不传就当没有——规划器不该为了一个还没配内容的学科编出一块空地。
   */
  english?: { due: number; newWords: number };
}): DailyPlan {
  const { repo, index, store, learnerId, budgetMinutes } = args;
  const blocks: PlanBlock[] = [];
  let left = Math.max(0, Math.floor(budgetMinutes));
  const notes: string[] = [];

  // ① 到期复习：优先，且最多吃掉预算的六成——复习是巩固，不是全部
  const due = repo.countDueReviews(learnerId);
  if (due > 0) {
    const want = Math.min(due * MINUTES_PER_REVIEW, Math.max(MINUTES_PER_REVIEW, Math.floor(budgetMinutes * 0.6)));
    if (want <= left) {
      blocks.push({
        kind: "review",
        minutes: want,
        title: `复习 ${Math.floor(want / MINUTES_PER_REVIEW)} 张到期卡片`,
        reason: "昨天做错或到期的题，今天先捡回来最划算",
      });
      left -= want;
    } else {
      notes.push(`到期复习有 ${due} 张，今天时间只够做一部分`);
    }
  }

  // ② 新课：挑一个"先修都点亮了、自己还没点亮"的节点
  const lesson = nextLesson(repo, index, store, learnerId);
  if (lesson && left >= MINUTES_PER_LESSON + MIN_PRACTICE_MINUTES) {
    blocks.push({
      kind: "lesson",
      minutes: MINUTES_PER_LESSON,
      title: `上一节「${lesson.name}」`,
      reason: "先修都会了，可以往前一步",
      nodeId: lesson.id,
      subject: lesson.subject,
    });
    left -= MINUTES_PER_LESSON;
  } else if (lesson) {
    notes.push(`「${lesson.name}」今天排不进来了，明天先上它`);
  }

  // ②b 英语：有到期的词或新词就排一小块（它和数学是两条线，谁也别挤掉谁）
  const englishDue = (args.english?.due ?? 0) + (args.english?.newWords ?? 0);
  if (englishDue > 0 && left >= MINUTES_PER_ENGLISH + MIN_PRACTICE_MINUTES) {
    blocks.push({
      kind: "english",
      minutes: MINUTES_PER_ENGLISH,
      title: `英语：复习 ${args.english?.due ?? 0} 个词、学 ${args.english?.newWords ?? 0} 个新词`,
      reason: "词要天天见，间隔开才记得住",
      subject: "en",
    });
    left -= MINUTES_PER_ENGLISH;
  }

  // ③ 练习：把剩下的时间给题，但至少留一点点探索的余地（如果本来就不多就全给练习）
  if (left > 0) {
    const explore = left >= MIN_PRACTICE_MINUTES + MINUTES_PER_EXPLORE ? MINUTES_PER_EXPLORE : 0;
    const practice = left - explore;
    if (practice > 0) {
      blocks.push({
        kind: "practice",
        minutes: practice,
        title: "做题巩固",
        reason: lesson ? "刚讲过的东西马上用一次" : "把已经会的东西练熟",
      });
    }
    if (explore > 0) {
      blocks.push({
        kind: "explore",
        minutes: explore,
        title: "随便逛逛、问点什么",
        reason: "没有具体目标也可以聊，好奇心不算浪费时间",
      });
    }
  }

  if (budgetMinutes <= 0) {
    return { blocks: [], totalMinutes: 0, leftMinutes: 0, note: "今天的时间用完了，明天再来" };
  }

  const totalMinutes = blocks.reduce((sum, b) => sum + b.minutes, 0);
  return {
    blocks,
    totalMinutes,
    leftMinutes: Math.max(0, Math.floor(budgetMinutes) - totalMinutes),
    ...(notes.length > 0 ? { note: notes.join("；") } : {}),
  };
}

/**
 * 下一节该学什么。
 *
 * 条件：这个节点有能发出去的题、自己还没点亮、先修都点亮了（或没有先修）。
 * 排序按图谱 order——课程顺序是编图谱的人定的，不该由题量或字母序决定。
 */
export function nextLesson(
  repo: Repo,
  index: GraphIndex,
  store: QuestionStore,
  learnerId: string,
): { id: string; name: string; subject: string } | null {
  const mastery = new Map(repo.allMastery(learnerId).map((row) => [row.nodeId, row]));

  const candidates = index.graph.nodes
    .filter((node) => (store.byNode.get(node.id) ?? []).some(practiceReady))
    .filter((node) => {
      const row = mastery.get(node.id);
      // 已经点亮（p 高、证据够）的不再当新课
      return !row || row.p < 0.85 || row.evidenceN < 3;
    })
    .filter((node) =>
      (node.prerequisites ?? []).every((pre) => {
        const row = mastery.get(pre);
        return row !== undefined && row.p >= 0.6;
      }),
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const first = candidates[0];
  return first ? { id: first.id, name: first.name, subject: first.subject } : null;
}
