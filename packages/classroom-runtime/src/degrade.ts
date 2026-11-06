/**
 * 各环节失败时的降级。
 *
 * 课堂有三个外部依赖会挂：语音（TTS）、生成（讲解内容）、视频（Manish 成片）。
 * 它们**任何一个挂了都不该让课上不下去**——孩子此刻在等的是"继续讲"，
 * 而不是"为什么没声音"。
 *
 * 做法是注入：调用方把每一步包成函数传进来，这里负责"挂了也不抛"，
 * 并记下挂在哪一步、为什么。这样"失败降级"是可回归的测试，
 * 而不是等线上出故障才知道有没有做。
 */

export type ClassroomStep = "tts" | "generate" | "video";

export interface StepOutcome<T = unknown> {
  step: ClassroomStep;
  ok: boolean;
  /** 成功时的值；失败时 undefined */
  value?: T;
  /** 失败原因，直接给人看（日志与家长端都会用到） */
  reason?: string;
}

/**
 * 跑一步，失败就记下来并返回 ok:false。**永不抛**。
 *
 * 为什么吞掉异常而不是往上抛：这一步是旁白/生成/成片，
 * 它们失败时课堂仍然有画面、有文字、有拍号。抛上去的结果是整个课堂停住，
 * 而停住比"没有语音但能继续看"糟得多。
 */
export async function runStep<T>(
  step: ClassroomStep,
  fn: () => Promise<T> | T,
): Promise<StepOutcome<T>> {
  try {
    return { step, ok: true, value: await fn() };
  } catch (err) {
    return { step, ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 降级记录：累计这次课上哪些环节挂了，供界面如实说明 */
export class DegradationLog {
  private readonly outcomes: StepOutcome[] = [];

  record(outcome: StepOutcome): void {
    if (!outcome.ok) this.outcomes.push(outcome);
  }

  get degraded(): boolean {
    return this.outcomes.length > 0;
  }

  /** 给人看的一句话；没降级时返回 null，让界面不必判断 */
  summary(): string | null {
    if (this.outcomes.length === 0) return null;
    const names: Record<ClassroomStep, string> = {
      tts: "语音",
      generate: "生成内容",
      video: "视频",
    };
    const parts = [...new Set(this.outcomes.map((o) => names[o.step]))];
    // 说清"仍然可以继续"，而不是只报故障：孩子看到的应当是可继续的路径
    return `${parts.join("、")}这次没能用上，课可以继续上`;
  }
}
