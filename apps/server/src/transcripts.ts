import type { Repo } from "./repo.js";

/**
 * 对话转写：家长可查看，**默认关**。
 *
 * 默认关不是因为"转写很难做"，而是因为开放对话里孩子说的那些话，
 * 原本是在"没人在旁边听"的默契下说的。默认录音等于替家长做了决定，
 * 而且孩子不会知道。要开就由家长显式打开，界面上一句话写清"只存在本机"。
 *
 * 三条纪律：
 * 1. 关着就一条都不写（不是"写进内存再丢"，是根本不进库）。
 * 2. 关掉再打开**不回溯**：已经说过的话没记就是没记，翻不回来。
 * 3. 被安全层拦下的那一轮绝不记原话，只记"被拦下了 + 原因"——
 *    与 safety.ts 的留痕同一条线：日志不该成为第二个泄露面。
 *
 * 写失败一律吞掉：转写是家长侧的知情辅助，不是对话的关键路径。
 * 让它把孩子的提问弄失败，是本末倒置。
 */

export interface TranscriptRecorder {
  /** 家长开没开。为 false 时下面三个方法都是空操作 */
  readonly enabled: boolean;
  /** 记一轮通过安检的话（user / assistant） */
  turn(role: "user" | "assistant", content: string): void;
  /** 记一次被拦下：不记原话，只记位置与原因 */
  blocked(where: "input" | "output", reason: string | null | undefined): void;
}

const NOOP: TranscriptRecorder = {
  enabled: false,
  turn: () => {},
  blocked: () => {},
};

export function transcriptRecorder(repo: Repo | undefined, learnerId: string | undefined): TranscriptRecorder {
  if (!repo || !learnerId) return NOOP;
  let enabled = false;
  try {
    enabled = repo.learnerPrefs(learnerId).recordTranscript === true;
  } catch {
    return NOOP;
  }
  if (!enabled) return NOOP;

  return {
    enabled,
    turn(role, content) {
      if (!content) return;
      try {
        repo.insertTranscript({ learnerId, role, content });
      } catch {
        /* 转写失败不该让对话失败 */
      }
    },
    blocked(where, reason) {
      try {
        // content 留空：拦下的原话连这里也不留
        repo.insertTranscript({ learnerId, role: "blocked", safetyReason: `${where}:${reason ?? "unknown"}` });
      } catch {
        /* 同上 */
      }
    },
  };
}
