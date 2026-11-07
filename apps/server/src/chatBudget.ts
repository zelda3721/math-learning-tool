import { DEFAULT_DAILY_CHAT_MINUTES, checkTimeBudget, type AgeBand } from "@mathtutor/safety";
import type { EducationLevel } from "@mathtutor/schema";
import type { Repo } from "./repo.js";

/**
 * 每日对话时长的记账与闸。
 *
 * 记法是「每轮对话结束后写一条 `chat-usage` 事件」，而不是维护一张累计表：
 * - 事件本身就是审计（家长看得到"今天几点聊了多久"），累计表只有一个数字，
 *   说不清是怎么攒出来的；
 * - 跨天边界靠事件时间戳自然处理，不需要半夜跑一个清零任务；
 * - 删孩子数据时，事件和时长一起走，不会留下一个对不上账的计数。
 */

/** 学段 → 时长档：小学低年级与中年级都按 primary 算（默认上限一样） */
export function ageBandOf(level: EducationLevel | string): AgeBand {
  if (level === "middle") return "middle";
  if (level === "high" || level === "advanced") return "high";
  return "primary";
}

/** 今天的零点是本地时间的零点：孩子是"今天"没时间了，不是"UTC 今天" */
function startOfToday(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface ChatBudget {
  allowed: boolean;
  usedMinutes: number;
  limitMinutes: number;
  remainingMinutes: number;
  /** 上限是家长设的还是按学段默认的——家长页要能说清这一点 */
  source: "parent" | "default";
}

export function chatLimitOf(repo: Repo, learnerId: string): { limitMinutes: number; source: "parent" | "default" } {
  const learner = repo.getLearner(learnerId);
  const prefs = repo.learnerPrefs(learnerId);
  const parentLimit = prefs.dailyChatMinutes;
  if (typeof parentLimit === "number" && Number.isFinite(parentLimit) && parentLimit >= 0) {
    return { limitMinutes: Math.floor(parentLimit), source: "parent" };
  }
  return { limitMinutes: DEFAULT_DAILY_CHAT_MINUTES[ageBandOf(learner?.level ?? "elementary_upper")], source: "default" };
}

/** 今天已用掉的秒数（四舍五入到分钟只用于展示，判定按秒） */
export function usedChatSecondsToday(repo: Repo, learnerId: string, now = new Date()): number {
  const since = startOfToday(now);
  return repo
    .listEvents(learnerId, "chat-usage")
    .filter((event) => new Date(event.ts).getTime() >= since)
    .reduce((sum, event) => {
      const payload = event.payload as { seconds?: unknown } | null;
      const seconds = typeof payload?.seconds === "number" ? payload.seconds : 0;
      return sum + Math.max(0, seconds);
    }, 0);
}

export function checkChatBudget(repo: Repo, learnerId: string, now = new Date()): ChatBudget {
  const { limitMinutes, source } = chatLimitOf(repo, learnerId);
  const usedMinutes = Math.round((usedChatSecondsToday(repo, learnerId, now) / 60) * 10) / 10;
  const { allowed, remainingMinutes } = checkTimeBudget(usedMinutes, limitMinutes);
  return { allowed, usedMinutes, limitMinutes, remainingMinutes: Math.round(remainingMinutes * 10) / 10, source };
}

/** 记一轮对话的时长。**只记时长，不记内容**：内容该留的地方在对话本身。 */
export function recordChatUsage(repo: Repo, learnerId: string, seconds: number): void {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded === 0) return;
  repo.appendEvent(learnerId, "chat-usage", { seconds: rounded });
}

/** 家长页要看的：今天聊了多久、还剩多少、上限是谁定的 */
export function chatBudgetReport(repo: Repo, learnerId: string): ChatBudget & { learnerId: string } {
  return { learnerId, ...checkChatBudget(repo, learnerId) };
}
