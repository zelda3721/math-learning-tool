/**
 * 时间轴：把「第几拍」变成「第几毫秒」，并且保证 **t → 帧** 是纯函数。
 *
 * 为什么要先有这个模块：阶段 2 的 DoD 是「同一时刻 t 的渲染逐像素一致」。
 * 逐像素只能靠浏览器验证，但**确定性的根在数据层**——只要画面完全由 t 决定，
 * 像素一致就是推论；反过来，只要画面对 t 之外的东西（计数器、上一帧的残留、
 * 定时器的迟到偏差）有任何依赖，截图比对会时红时绿，人就会开始怀疑测试而不是代码。
 *
 * 所以这里不碰 DOM、不碰 requestAnimationFrame、不读时钟：
 * 给定 (beatCount, 选项)，任何时刻的画面归属都是算出来的，不是"等着它到"。
 */

export interface TimelineOptions {
  /** 每拍的基础时长（毫秒） */
  beatMs?: number;
  /**
   * 转场时长（毫秒）：上一拍淡出、下一拍淡入。
   * 0 表示硬切（截图比对时用 0 最省事——中间态没有意义）。
   */
  transitionMs?: number;
}

export const DEFAULT_BEAT_MS = 3200;
export const DEFAULT_TRANSITION_MS = 420;

export interface TimelineFrame {
  /** 实际参与计算的时刻（已钳制到 [0, duration]） */
  tMs: number;
  /** 此刻主导画面的那一拍 */
  beatIndex: number;
  /** 本拍内已推进的比例 0..1（落在转场里时为 1，表示这一拍已经走完） */
  local: number;
  /** 正处在转场中时给出从哪到哪；否则为 undefined */
  transition?: { from: number; to: number; progress: number };
}

export interface Timeline {
  /** 总时长 = 拍数 × 每拍时长（不含末尾转场） */
  readonly duration: number;
  readonly beatCount: number;
  /** 第 i 拍的起始时刻；越界时钳制到首尾 */
  beatStart(i: number): number;
  /** 时刻 → 帧。**纯函数**：同样输入必得同样输出 */
  frameAt(tMs: number): TimelineFrame;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function buildTimeline(beatCount: number, opts: TimelineOptions = {}): Timeline {
  const beatMs = Math.max(1, opts.beatMs ?? DEFAULT_BEAT_MS);
  const transitionMs = Math.max(0, Math.min(opts.transitionMs ?? DEFAULT_TRANSITION_MS, beatMs));
  const count = Math.max(0, Math.floor(beatCount));
  const duration = count * beatMs;

  const beatStart = (i: number): number => {
    if (count === 0) return 0;
    return clamp(Math.floor(i), 0, count - 1) * beatMs;
  };

  return {
    duration,
    beatCount: count,
    beatStart,

    frameAt(tMs: number): TimelineFrame {
      if (count === 0) return { tMs: 0, beatIndex: 0, local: 0 };
      const t = clamp(Number.isFinite(tMs) ? tMs : 0, 0, duration);

      // 落在最后一拍的末尾：画面就是最后一拍走完的样子（不是"转场到空白"）
      if (t >= duration) {
        return { tMs: t, beatIndex: count - 1, local: 1 };
      }

      const idx = Math.floor(t / beatMs);
      const inBeat = t - idx * beatMs;

      /*
       * 转场放在**每拍的末尾**，而不是下一拍的开头。
       *
       * 这样第 i 拍独占 [i×beatMs, i×beatMs + beatMs)，"这一拍播完了"与
       * "时间走到倍数的位置"是同一件事，外部按拍对时（比如字幕轨、旁白）不用做偏移换算。
       */
      const transStart = beatMs - transitionMs;
      if (transitionMs > 0 && inBeat >= transStart && idx + 1 < count) {
        return {
          tMs: t,
          beatIndex: idx,
          local: 1,
          transition: { from: idx, to: idx + 1, progress: (inBeat - transStart) / transitionMs },
        };
      }

      return { tMs: t, beatIndex: idx, local: inBeat / beatMs };
    },
  };
}

/**
 * 播放头：把"时间在走"这件事收敛成一个可测的对象。
 *
 * 它不认识 DOM、不认识 requestAnimationFrame，只回答两个问题：
 * 现在多少毫秒、这一刻该是哪一帧。播放器负责把帧画出来，时钟负责告诉它过了多久——
 * 三者分开，才可能在 node 里把"播放到最后一拍会停"这类行为测干净。
 */
export class Playhead {
  readonly timeline: Timeline;
  private t = 0;

  constructor(timeline: Timeline) {
    this.timeline = timeline;
  }

  get time(): number {
    return this.t;
  }

  /** 是否已经走到末尾（等于总时长） */
  get finished(): boolean {
    return this.t >= this.timeline.duration;
  }

  /** 跳到指定时刻；返回该时刻的帧。越界自动钳制 */
  seek(tMs: number): TimelineFrame {
    const t = Number.isFinite(tMs) ? tMs : 0;
    this.t = Math.max(0, Math.min(this.timeline.duration, t));
    return this.timeline.frameAt(this.t);
  }

  /**
   * 前进 dtMs。负值与 NaN 一律当成"没动"——
   * 时钟回拨（有的浏览器在页面切后台后会）不该让画面倒退。
   */
  advance(dtMs: number): TimelineFrame {
    if (!Number.isFinite(dtMs) || dtMs <= 0) return this.timeline.frameAt(this.t);
    return this.seek(this.t + dtMs);
  }

  /** 第 i 拍的起始时刻；返回该时刻的帧 */
  seekBeat(i: number): TimelineFrame {
    return this.seek(this.timeline.beatStart(i));
  }
}
