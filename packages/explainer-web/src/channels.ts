import type { BeatState } from "./fold.js";
import { easeOutCubic } from "./motion.js";

/**
 * 动作通道：一拍之内"什么时候强调谁"。
 *
 * 和补间一样，这里只算时间，不画东西——通道的输出是"某个对象在某一刻的强度 0..1"，
 * 播放器拿它决定不透明度/描边。这样 seek 到任意时刻，强调状态也是算出来的：
 * 从前那些效果是"渲染完顺手起一个 CSS 动画"，一旦被打断就永远对不上 t。
 *
 * 只在拍内做，不做跨拍：跨拍的事归转场补间管。两者混在一起会让"这一拍什么时候结束"
 * 变得说不清，而字幕轨、旁白、课堂脚本都要按拍对时。
 */

export type ChannelKind = "reveal" | "spotlight" | "annotate" | "state";

export interface ChannelCue {
  /** 目标对象（组 id） */
  target: string;
  kind: ChannelKind;
  /** 拍内比例区间 [from, to]，0..1 */
  from: number;
  to: number;
  /** annotate 用：贴在对象旁边的短句 */
  text?: string;
  /**
   * state 用：拍内要数到的数值。
   * 刻意不叫 `from`/`to`——那两个名字已经被时间区间占了，
   * 同一个字段一会儿是比例一会儿是数量，读代码的人迟早看错一次。
   */
  toValue?: number;
}

/** 新出现的对象用前 55% 的时间露出来，留出看的时间再进转场 */
const REVEAL_SPAN = 0.55;
/** 强调在中段：开头不抢"新出现"的戏，结尾让位给转场 */
const SPOTLIGHT_FROM = 0.12;
const SPOTLIGHT_TO = 0.9;
/** 超过这个长度就不往画布上贴：它会盖住图形，而字幕那边已经在说了 */
const ANNOTATE_MAX_CHARS = 18;
/** 数数的窗口：比 spotlight 晚一点起、早一点收，免得和强调抢同一段时间 */
const STATE_FROM = 0.15;
const STATE_TO = 0.85;

/**
 * 为一拍的每个对象排出通道。
 *
 * 数据来源刻意只用 BeatState 已有的东西，不新增字段：
 * - **reveal**：这一拍才出现的组（上一拍没有它）
 * - **spotlight**：这一拍被动作点到的组（fold 已经把 `emphasis` 打在它们身上）
 *
 * 于是"谁在什么时候被强调"不需要额外声明，也不会和 fold 的语义打架。
 */
export function cuesForBeat(beat: BeatState, previous?: BeatState): ChannelCue[] {
  const cues: ChannelCue[] = [];
  const before = new Set((previous?.groups ?? []).map((g) => g.id));

  for (const group of beat.groups) {
    if (!before.has(group.id) && previous !== undefined) {
      cues.push({ target: group.id, kind: "reveal", from: 0, to: REVEAL_SPAN });
    } else if (beat.index === 0 && previous === undefined) {
      // 第一拍没有"上一拍"可比：全部当作出现，否则整片开场是空的
      cues.push({ target: group.id, kind: "reveal", from: 0, to: REVEAL_SPAN });
    }
  }

  const revealed = new Set(cues.map((c) => c.target));

  /*
   * annotate：把本拍的讲解句**钉到被强调的那个对象旁边**。
   *
   * 只给第一个被点到的组，且只在句子够短时给：
   * - 一拍里点多组时，同一句话贴三处只是噪音，观众反而不知道该看哪儿；
   * - 长句在画布上会盖住图形，而它已经在下方的字幕里了——字幕负责说完，
   *   画布上的标注只负责"指这里"。
   */
  /*
   * state：**拍内**的量在动（最典型的就是"数一遍"）。
   *
   * 和另外两件事划清界限，免得变成同一件事的第三种说法：
   * - `set_value`（fold 的动作）改的是**拍间**的量，下一拍才生效，平滑由转场补间负责；
   * - 补间插的是**转场那条缝**里的位置与几何；
   * - state 只管**一拍之内**：数字从头走到这一拍真实的数量。
   *
   * 走到的是 `actual` 而不是 `claimed`：计数走到的必须是画面上真的有多少个。
   * 宣称值对不上是**要被看见的错误**（counts 里记着），不是拿来动画的目标。
   */
  for (const count of beat.counts) {
    if (!Number.isFinite(count.actual)) continue;
    cues.push({
      target: count.groupId,
      kind: "state",
      from: STATE_FROM,
      to: STATE_TO,
      toValue: count.actual,
      text: String(count.actual),
    });
  }

  const firstEmphasized = beat.groups.find((g) => g.emphasis === true);
  const line = (beat.teachingLine ?? "").trim();
  if (firstEmphasized && line && line.length <= ANNOTATE_MAX_CHARS) {
    cues.push({
      target: firstEmphasized.id,
      kind: "annotate",
      from: SPOTLIGHT_FROM,
      to: SPOTLIGHT_TO,
      text: line,
    });
  }
  for (const group of beat.groups) {
    if (group.emphasis !== true) continue;
    // 同一拍里刚露出来的对象不必再强调一次：那会把它压回 0 再亮起来，看着像闪屏
    if (revealed.has(group.id)) continue;
    cues.push({
      target: group.id,
      kind: "spotlight",
      from: SPOTLIGHT_FROM,
      to: SPOTLIGHT_TO,
    });
  }

  return cues;
}

export function buildChannels(beats: BeatState[]): ChannelCue[][] {
  return beats.map((beat, i) => cuesForBeat(beat, i > 0 ? beats[i - 1] : undefined));
}

/**
 * 某一刻每个对象的强度（0..1）。没被任何通道点到的对象不在返回值里。
 *
 * 强度是渐入渐出的三角波，不是阶跃——阶跃在 60fps 下就是一帧之内从全暗到全亮，
 * 那不是"强调"，那是闪。
 */
export function intensityAt(cues: ChannelCue[], local: number): Map<string, number> {
  const p = Number.isFinite(local) ? Math.max(0, Math.min(1, local)) : 0;
  const out = new Map<string, number>();
  for (const cue of cues) {
    const span = cue.to - cue.from;
    if (span <= 0) continue;
    if (p < cue.from || p > cue.to) continue;
    const q = (p - cue.from) / span;
    // 三角波：0 → 1 → 0
    const strength = q < 0.5 ? q * 2 : (1 - q) * 2;
    out.set(cue.target, Math.max(out.get(cue.target) ?? 0, strength));
  }
  return out;
}

/**
 * reveal 的不透明度（单向：出现之后不能回去）。
 *
 * 起点给 0.25 而不是 0：停在第一拍第 0 秒时，整片画面不该是一片空白——
 * "刚出现"与"什么都没有"在观看者眼里是两回事，而暂停在开头恰恰是最常见的时刻。
 */
export function revealOpacityAt(cue: ChannelCue, local: number): number {
  const p = Number.isFinite(local) ? Math.max(0, Math.min(1, local)) : 0;
  if (cue.kind !== "reveal") return 1;
  if (p >= cue.to) return 1;
  const span = cue.to - cue.from;
  if (span <= 0) return 1;
  const q = Math.max(0, Math.min(1, (p - cue.from) / span));
  return 0.25 + 0.75 * q;
}

/**
 * state 通道在某一刻应当显示的数值：从 0 数到 toValue，数完就停。
 *
 * 单向，和 reveal 一个道理——"数完了"不该在下半拍又倒回去。
 * 缓动与补间共用一套：一条画面里两种缓动曲线，只会让"变化"读起来忽快忽慢。
 */
export function stateValueAt(cue: ChannelCue, local: number, ease = easeOutCubic): number {
  const target = cue.toValue ?? 0;
  if (cue.kind !== "state") return target;
  const p = Number.isFinite(local) ? Math.max(0, Math.min(1, local)) : 0;
  if (p >= cue.to) return target;
  if (p <= cue.from) return 0;
  const span = cue.to - cue.from;
  if (span <= 0) return target;
  return target * ease((p - cue.from) / span);
}
