import { DEFAULT_DAILY_CHAT_MINUTES, checkTimeBudget, type AgeBand } from "@mathtutor/safety";
import type { EducationLevel } from "@mathtutor/schema";
import type { Repo } from "./repo.js";

/**
 * 每日使用时长的记账与闸。
 *
 * **记的是孩子的使用时间，不是模型的推理时间。**
 * 早先每轮对话结束后记的是 `Date.now() - startedAt`，那是服务端等模型的时间：
 * 孩子盯着屏幕一小时，可能只被记成几十秒，上限永远也到不了。现在由前端的
 * 活跃心跳上报（只在标签页可见时计时），服务端按真实流逝时间封顶，见
 * `recordActiveUsage` 与 `routes/usage.ts`。
 *
 * 事件类型的沿革：`chat-usage` 是心跳之前的旧记录（那时只记对话），
 * `active-usage` 是现在的记录。两者都算进"今天用了多少"——升级当天的旧记录
 * 不该凭空消失；写入只有 `active-usage` 一条路，不会重复计。
 *
 * 记法是「一段时间写一条事件」，而不是维护一张累计表：
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
  const sinceMs = startOfToday(now);
  let total = 0;
  for (const type of ["chat-usage", "active-usage"]) {
    for (const event of repo.listEvents(learnerId, type)) {
      if (new Date(event.ts).getTime() < sinceMs) continue;
      const payload = event.payload as { seconds?: unknown } | null;
      const seconds = typeof payload?.seconds === "number" ? payload.seconds : 0;
      total += Math.max(0, seconds);
    }
  }
  return total;
}

export function checkChatBudget(repo: Repo, learnerId: string, now = new Date()): ChatBudget {
  const { limitMinutes, source } = chatLimitOf(repo, learnerId);
  const usedMinutes = Math.round((usedChatSecondsToday(repo, learnerId, now) / 60) * 10) / 10;
  const { allowed, remainingMinutes } = checkTimeBudget(usedMinutes, limitMinutes);
  return { allowed, usedMinutes, limitMinutes, remainingMinutes: Math.round(remainingMinutes * 10) / 10, source };
}

/** 记一轮对话的时长（旧口径：只有对话那条线在记，保留给既有调用与审计）。 */
export function recordChatUsage(repo: Repo, learnerId: string, seconds: number): void {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded === 0) return;
  repo.appendEvent(learnerId, "chat-usage", { seconds: rounded });
}

/**
 * 心跳报上来的**使用时间**（毫秒精度到秒）。
 *
 * 为什么不直接信客户端：孩子（或者只是页面卡住重发）能把 seconds 报成任何数。
 * 所以每个孩子记一个上次上报的时刻，这次最多认"真实流逝了多久"——
 * 空闲时页面不计时，报上来的本来就小于流逝时间；而想多报也超不过墙上时钟。
 * 上限 300 秒一条，防止一次补报把半天算成一天。
 */
const lastReportAt = new Map<string, number>();

export function recordActiveUsage(
  repo: Repo,
  learnerId: string,
  seconds: number,
  nowMs = Date.now(),
): { recorded: number; rejected: boolean } {
  const last = lastReportAt.get(learnerId);
  const elapsed = last === undefined ? Infinity : (nowMs - last) / 1000;
  // 首次上报没有参照，按一个心跳周期放行
  const ceiling = last === undefined ? 120 : Math.min(300, Math.max(0, elapsed) * 1.5 + 10);
  const wanted = Math.max(0, seconds);
  const recorded = Math.min(wanted, ceiling);
  lastReportAt.set(learnerId, nowMs);
  if (recorded >= 1) repo.appendEvent(learnerId, "active-usage", { seconds: Math.round(recorded) });
  return { recorded: Math.round(recorded), rejected: wanted > ceiling + 1 };
}

/**
 * 时间用完了的统一响应体（各入口共用，话是给孩子看的）。
 *
 * 为什么不做成中间件：入口的语义不一样（开始一组练习 vs 开一节课 vs 查一次词），
 * 但"用完了"这句话必须只有一份——四处各写一句，迟早有一处变成状态码。
 */
export function budgetBlockedPayload(
  repo: Repo,
  learnerId: string,
): { error: string; budget: ChatBudget } | null {
  const budget = checkChatBudget(repo, learnerId);
  if (budget.allowed) return null;
  return {
    error: `今天的时间用完了（每天 ${budget.limitMinutes} 分钟）。明天再来，或者先去和家长说一声。`,
    budget,
  };
}

/** 家长页要看的：今天聊了多久、还剩多少、上限是谁定的 */
export function chatBudgetReport(repo: Repo, learnerId: string): ChatBudget & { learnerId: string } {
  return { learnerId, ...checkChatBudget(repo, learnerId) };
}
