import { screenInput, screenOutput, type SafetyVerdict } from "@mathtutor/safety";
import type { Repo } from "./repo.js";

/**
 * 安全层的接线：对话入口在**调模型之前**和**回孩子之前**各过一道安检。
 *
 * 为什么集中在服务器而不是前端：前端拦等于建议，换个客户端就绕过去了；
 * 而且孩子手里的数据本来就不该包含"服务器允许发送"的判断依据。
 *
 * 拦下的都要留痕（`learner_events` 的 `safety` 事件）——家长中心要能看见
 * "孩子今天问过一次不该问的话"，这既是保护孩子也是保护家长知情。
 * 但留痕里只存命中的规则名与时间，**不存原文**：日志本身不该成为第二个泄露面。
 */

export interface SafetyDecision {
  verdict: SafetyVerdict;
  /** 给孩子看的固定话术（blocked/redirect 时非空） */
  reply: string;
  blocked: boolean;
}

function log(repo: Repo | undefined, learnerId: string | undefined, where: "input" | "output", verdict: SafetyVerdict): void {
  if (!repo || !learnerId || verdict.action === "allow") return;
  try {
    repo.appendEvent(learnerId, "safety", {
      where,
      action: verdict.action,
      reason: verdict.reason ?? null,
      // 只记命中的规则（正则源码），不记孩子原话
      rules: verdict.matched?.length ?? 0,
    });
  } catch {
    // 留痕失败不该让对话失败：安全决策本身已经生效
  }
}

/** 孩子说进来的话 */
export function screenLearnerInput(
  repo: Repo | undefined,
  learnerId: string | undefined,
  text: string,
): SafetyDecision {
  const verdict = screenInput(text);
  log(repo, learnerId, "input", verdict);
  return {
    verdict,
    reply: verdict.action === "allow" ? "" : (verdict.reply ?? ""),
    blocked: verdict.action !== "allow",
  };
}

/**
 * 模型要说出去的话。
 *
 * 输出侧只拦确定的泄露（联系方式、上门承诺）。拦下之后**不原样透出模型的话**，
 * 换成一句固定话术并留痕——半截被改过的模型回复比一句干脆的替换更让人困惑。
 */
export function screenModelOutput(
  repo: Repo | undefined,
  learnerId: string | undefined,
  text: string,
): SafetyDecision {
  const verdict = screenOutput(text);
  log(repo, learnerId, "output", verdict);
  if (verdict.action === "allow") return { verdict, reply: text, blocked: false };
  return {
    verdict,
    reply: "这段回复里有些内容不适合现在说，我先收回。我们回到题目上，你想到哪一步了？",
    blocked: true,
  };
}
