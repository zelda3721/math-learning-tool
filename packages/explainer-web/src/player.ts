/**
 * ExplainerPlayer —— Web 动态讲解（模式 A）。
 *
 * 它要做的事只有一件：**让图形替数学说话**。
 * - 曲线是真算出来的（math/expr + math/sample），算不出就说算不出，绝不画装饰曲线
 * - 全场景一个坐标系，根/切线/矩形与曲线严丝合缝
 * - 数量单位有身份，拍间飞行——「变的是位置，不变的是总数」看得见
 * - 割线→切线、矩形加密、两侧逼近、复合三段，都是过程而非一张终态图
 */
import type { SceneSpec } from "@mathtutor/schema";
import { foldBeats, type BeatState } from "./fold.js";
import { Playhead, buildTimeline, type TimelineFrame } from "./timeline.js";
import { tweenBarGeometry, tweenPoint, type BarGeometry, type Point } from "./motion.js";
import { atomOpacity } from "./formulas.js";
import { defaultVisuals, type VisualRegistry } from "./visuals.js";
import { gateBeats } from "./gate.js";
import { buildChannels, intensityAt, revealOpacityAt, stateValueAt, type ChannelCue } from "./channels.js";
import {
  limitSwaps,
  liveTotal,
  solveScene,
  swappedCount,
  unitTotals,
  withLiveBar,
  type Scene,
  type SceneIssue,
  type Shape,
} from "./render/scene.js";
import {
  layoutFlowed,
  type PlacedBar,
  type PlacedCard,
  type PlacedExtent,
  type PlacedFigure,
  type PlacedLabel,
  type PlacedSentence,
  type PlacedUnits,
} from "./render/layout.js";
import { renderSolved } from "./figure/render.js";
import type { FigureSpec } from "@mathtutor/schema";
import type { CoordSystem } from "./math/coords.js";

/**
 * 公式渲染器：由调用方注入（本包零第三方依赖，KaTeX 留在 apps/web）。
 *
 * 返回 `atoms` 是关键——公式要逐项显现，就得知道它被切成了哪几块。
 * 没有注入时回落成纯文本：`$x^2$` 会连着美元符号一起画出来，
 * 难看但诚实，而且不会因为缺依赖就崩掉整个播放器。
 */
export type MathRenderer = (tex: string, displayMode: boolean) => {
  root: HTMLElement;
  atoms: HTMLElement[];
};

/** 时钟：浏览器里是 requestAnimationFrame + performance.now，测试里可以手动喂时间 */
export interface PlayerClock {
  now(): number;
  schedule(cb: () => void): number;
  cancel(handle: number): void;
}

const browserClock: PlayerClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  schedule: (cb) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(cb)
      : (setTimeout(cb, 16) as unknown as number),
  cancel: (h) => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
    else clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
  },
};

export interface PlayerOptions {
  autoPlay?: boolean;
  /** 每拍时长（毫秒）；时间轴按它铺开，缺省 3200 */
  beatMs?: number;
  /** 转场时长（毫秒）；0 = 硬切。截图比对时用 0 */
  transitionMs?: number;
  /** 注入时钟（测试用），缺省浏览器时钟 */
  clock?: PlayerClock;
  /** 注入公式渲染器（缺省把 LaTeX 当纯文本画） */
  math?: MathRenderer;
  /** 视觉词表：学科新增图元从这里注入（缺省只有内置数学图元） */
  visuals?: VisualRegistry;
  onBeatChange?: (index: number, total: number) => void;
  /** 算不出的曲线、未知构件、计数不一致——诚实上报 */
  onIssue?: (issue: SceneIssue) => void;
  /** 关掉自带控制条（调用方自绘） */
  controls?: boolean;
}

const NS = "http://www.w3.org/2000/svg";

/** 与 apps/web 设计系统同源：曲线用墨蓝，过程用靛蓝，结论用金，判定用绿红 */
const C = {
  ink: "#16203a",
  inkFaint: "#8b95ab",
  rule: "#dde2ec",
  beam: "#2b5ce6",
  lit: "#e0a32e",
  correct: "#1f9d6b",
  wrong: "#d3453f",
  paper: "#f6f7fa",
};

/**
 * 组身份通道：颜色 × 形状。两条维度一起用，色觉障碍与灰度打印下也分得清。
 * 顺序与 layout.ts 的 COLOR_CHANNELS 一一对应（那边定语义，这边定长相）。
 *
 * 刻意避开金色 `--color-lit`：在这套设计里金色是「掌握状态」的数据色，
 * 只属于"这个知识点点亮了"。讲解画面里再用一次，那个信号就不值钱了。
 * 所以 spec 的 yellow / gold 落到青铜与石板灰——形状通道保证它们依然一眼可辨。
 */
const CHANNELS = ["#2b5ce6", "#8a6a20", "#d3453f", "#1f9d6b", "#e07b39", "#7b4fd1", "#0f8c94", "#5b6b8c"];
type UnitShape = "circle" | "square" | "triangle" | "diamond";
const SHAPES: UnitShape[] = ["circle", "square", "triangle", "diamond", "circle", "square", "triangle", "diamond"];

/** 底部事实条占用的高度：内容区绝不侵占它（画面不许自己压自己） */
const FACTS_H = 58;
/** 实时读数条的高度。加了它却忘了在布局里留位置，读数就会压在方块上——犯过一次 */
const TALLY_H = 30;

const reduceMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function el(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export class ExplainerPlayer {
  readonly beatCount: number;

  private readonly container: HTMLElement;
  private readonly beats: BeatState[];
  private readonly opts: PlayerOptions;
  private readonly root: HTMLDivElement;
  private readonly svg: SVGElement;
  private readonly caption: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private controlsEl: HTMLDivElement | null = null;

  private index = 0;
  private readonly clock: PlayerClock;
  private readonly playhead: Playhead;
  private raf: number | null = null;
  private lastTickMs = 0;
  private playing = false;
  private destroyed = false;
  private width = 640;
  private height = 380;
  /**
   * 转场补间的目标位置与进度（由时间轴给出）。
   * 非转场帧一律为 null——画面就是本拍该有的样子，不掺上一帧的残留。
   */
  private motion: {
    positions: Map<string, Point>;
    bars: Map<string, BarGeometry>;
    progress: number;
  } | null = null;
  /** 目标拍的落点缓存（按拍与画布高度），转场时每帧都要用，别重算 */
  private readonly posCache = new Map<string, { units: Map<string, Point>; bars: Map<string, BarGeometry> }>();
  /** 每拍的动作通道（谁在拍内什么时候被强调） */
  private readonly visuals: VisualRegistry;
  private readonly channels: ChannelCue[][];
  /** 本帧在拍内的比例，通道按时生效 */
  private local = 0;
  /** 每个组画出来的节点：通道要靠改透明度生效，重建整幅画面太贵 */
  private readonly groupNodes = new Map<string, SVGElement[]>();
  /** 每个组的画面范围：标注要知道"贴在谁旁边" */
  private readonly groupBoxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  /** 每次重绘收集到的公式原子块（逐项显现按帧改透明度） */
  private mathBlocks: HTMLElement[][] = [];
  /** 每组那个"数量"文字节点：state 通道按帧改它的内容，不重排版 */
  private readonly countNodes = new Map<string, SVGTextElement>();
  /** 本拍的标注（贴纸 + 引线），透明度随通道强度更新 */
  private annotation: { cue: ChannelCue; nodes: SVGElement[] } | null = null;
  private reportedIssues = new Set<string>();
  /**
   * 本拍「已经换了几只」。假设法的道理不在终态而在过程——
   * 每换一只，个体数一个不变、记号数多两根。只给终态，这个因果就得靠脑补。
   */
  private subK = 0;
  private subSteps = 0;
  private scrubEl: HTMLInputElement | null = null;
  /** 拨动时「正在变的那个量」现在多少（没有可靠来源时为空——宁可不画） */
  private live: { value: number; from: number; to: number } | undefined;

  constructor(container: HTMLElement, spec: SceneSpec, opts: PlayerOptions = {}) {
    this.container = container;
    this.opts = opts;
    this.visuals = opts.visuals ?? defaultVisuals;
    this.beats = foldBeats(spec, this.visuals);
    this.beatCount = this.beats.length;
    this.clock = opts.clock ?? browserClock;
    this.playhead = new Playhead(
      buildTimeline(this.beatCount, { beatMs: opts.beatMs, transitionMs: opts.transitionMs }),
    );
    this.channels = buildChannels(this.beats);
    /*
     * 语义门禁在装配时就跑一次：它不是"看着不对劲就提示"，而是把
     * 「宣称的数量对不上」「说了过程却没搬东西」「验证空框」这三类事直接报出来。
     * 走既有的 onIssue 通道——和"曲线没算出来"一样，宁可让孩子看到一句提示，
     * 也不要让一张看着正常、其实什么也没证明的图过关。
     */
    if (opts.onIssue) {
      const gateInput = spec as unknown as { scenes?: { actions?: { op?: string }[] }[] };
      for (const finding of gateBeats(this.beats, gateInput)) {
        opts.onIssue({ kind: "semantic", detail: finding.detail });
      }
    }

    this.root = document.createElement("div");
    this.root.style.cssText = "display:flex;flex-direction:column;gap:10px;width:100%";

    const stage = document.createElement("div");
    stage.style.cssText = `position:relative;width:100%;background:${C.paper};border:1px solid ${C.rule};border-radius:12px;overflow:hidden`;
    this.svg = el("svg", { width: "100%", viewBox: `0 0 ${this.width} ${this.height}`, role: "img" });
    (this.svg as SVGSVGElement).style.display = "block";
    stage.appendChild(this.svg);

    this.notice = document.createElement("div");
    this.notice.style.cssText = `padding:6px 12px;font-size:12px;color:${C.wrong};display:none`;

    this.caption = document.createElement("div");
    this.caption.style.cssText = `min-height:22px;padding:0 2px;font-size:15px;line-height:1.6;color:${C.ink}`;

    this.root.append(stage, this.notice, this.caption);
    if (opts.controls !== false) this.root.appendChild(this.buildControls());
    container.appendChild(this.root);

    // 开在「可以拨」的那一拍上。滑杆停在 0 时画面正是假设态，
    // 所以铺垫那一拍并没有被跳过——它就是滑杆的起点，一拉就走完全程。
    const interactive = this.firstScrubbableBeat();
    if (interactive > 0) {
      this.index = interactive;
      this.playhead.seekBeat(interactive);
      this.startSubPlayback();
    } else {
      // 从第 0 拍开画。少了这一句，seek(0) 会拿到一个空画布——
      // 看起来像"播放器坏了"，其实只是从来没人要求它画过第一帧。
      this.render();
    }
    if (opts.autoPlay) this.play();
  }

  /** 第一个能拨的拍；没有就返回 0（照常从头看） */
  private firstScrubbableBeat(): number {
    for (let i = 0; i < this.beats.length; i += 1) {
      const beat = this.beats[i];
      if (beat && swappedCount(solveScene(beat, this.width, this.height, 600, this.visuals)) > 0) return i;
    }
    return 0;
  }

  // ── 播放控制 ───────────────────────────────────────────

  /** 总时长（毫秒） */
  get duration(): number {
    return this.playhead.timeline.duration;
  }

  /** 当前时刻（毫秒） */
  get currentTime(): number {
    return this.playhead.time;
  }

  play(): void {
    if (this.destroyed || this.playing) return;
    // 已经播到头：再按播放就从头来，而不是原地不动装死
    if (this.playhead.finished) this.seek(0);
    this.playing = true;
    this.syncControls();
    this.lastTickMs = this.clock.now();
    this.scheduleTick();
  }

  pause(): void {
    this.playing = false;
    if (this.raf !== null) this.clock.cancel(this.raf);
    this.raf = null;
    this.syncControls();
  }

  next(): void {
    this.seekBeat(this.index + 1);
  }

  prev(): void {
    this.seekBeat(this.index - 1);
  }

  goTo(i: number): void {
    this.seekBeat(i);
  }

  /** 跳到指定时刻（毫秒）。画面由时间决定，与"怎么走到这里"无关 */
  seek(tMs: number): void {
    if (this.destroyed) return;
    const frame = this.playhead.seek(tMs);
    this.applyFrame(frame);
    this.syncControls();
  }

  seekBeat(i: number): void {
    if (this.destroyed) return;
    this.applyFrame(this.playhead.seekBeat(i));
    this.syncControls();
  }

  /**
   * 应用一帧。画面由（哪一拍、转场进度）共同决定，两者都来自时间轴：
   * 跨拍就重建，同拍处在转场窗口里就按进度插值重绘。
   *
   * 减弱动效（reduceMotion）时不做补间：直接跳到下一拍该有的样子，
   * 而不是把这一拍的单位预先画到下一拍的位置上——那样标签与图形会对不上。
   */
  private applyFrame(frame: TimelineFrame): void {
    /*
     * 顺序很重要：先换拍（清掉一拍内的拨动状态），**再**装补间。
     * 反过来写过一版——motion 先设好、再调 startSubPlayback()，被它顺手清掉，
     * 于是"正着播到转场"有动画、"seek 进转场"没有。画面取决于你怎么走到这里，
     * 这正是确定性最不能容忍的那种错。播放器实验台里抓到的。
     */
    const beatChanged = frame.beatIndex !== this.index;
    if (beatChanged) {
      this.index = frame.beatIndex;
      this.subK = 0;
    }

    const hadMotion = this.motion !== null;
    this.motion =
      frame.transition && !reduceMotion()
        ? (() => {
            const targets = this.targetsOf(frame.transition.to);
            return { positions: targets.units, bars: targets.bars, progress: frame.transition.progress };
          })()
        : null;

    /*
     * 什么时候必须重画：
     * - 换拍了：内容变了
     * - 正在转场：位置随进度变
     * - **刚离开转场**（hadMotion）：上一帧画的是被位移过的单位，不重画就停在半路上
     *
     * 第三种最容易漏，也最伤人：seek(0) 落在一个"既不换拍也没转场"的时刻，
     * 于是画面原封不动，看上去像跳转失败——其实是没人要求它把位移收回去。
     * 播放器实验台里抓到的（同一时刻两次渲染不一致，正是这条）。
     *
     * 一拍之内的静止帧不重画，是刻意的：播放时每帧都重解一次场景太贵，
     * 而静止帧的内容本来就没变。
     */
    this.local = frame.local;
    if (beatChanged || frame.transition || hadMotion) this.render();
    else {
      this.applyFormulaReveal();
      this.applyChannels();
    }
  }

  /**
   * 本拍的标注：一条引线 + 一句短话，钉在被强调的对象旁边。
   *
   * 画出来时先给透明度 0，由通道的强度决定显隐——这样"什么时候出现"仍然由 t 决定，
   * 而不是"画的时候顺手淡入"。没有标注的那个组，它自己也不知道被区别对待了。
   */
  private drawAnnotation(): void {
    this.annotation = null;
    const cue = (this.channels[this.index] ?? []).find((c) => c.kind === "annotate");
    const box = cue ? this.groupBoxes.get(cue.target) : undefined;
    if (!cue?.text || !box) return;

    const nodes: SVGElement[] = [];
    const anchorX = box.x + box.w;
    const anchorY = box.y + 6;
    const textX = Math.min(this.width - 168, anchorX + 14);
    const textY = Math.max(16, box.y - 10);

    nodes.push(
      el("line", {
        x1: anchorX, y1: anchorY, x2: textX - 4, y2: textY,
        stroke: C.beam, "stroke-width": 1.5, "stroke-dasharray": "4 3",
      }),
    );
    const label = el("text", {
      x: textX, y: textY, "font-size": 12, fill: C.beam, "font-weight": 600, "text-anchor": "start",
    });
    label.textContent = cue.text;
    nodes.push(label);

    for (const node of nodes) {
      node.setAttribute("opacity", "0");
      this.svg.appendChild(node);
    }
    this.annotation = { cue, nodes };
  }

  /**
   * 把通道强度落到已画好的节点上。
   *
   * 不重建画面：通道每帧都在变（一拍里几十帧），重建要重解场景+重排版，
   * 而它实际只改一个透明度属性。节点在绘制时按组收好，这里按组改。
   *
   * 两条语义上的讲究：
   * - **reveal 是单向的**：窗口过去之后必须停在 1，不能回到 0——那是"出现"，不是"脉冲"，
   *   回到 0 会让新出现的东西整拍后半段都不见了。
   * - **spotlight 是脉冲**：没有它的时候，其他组回到 1。
   */
  /**
   * 公式的逐项显现：按本帧的拍内进度设置每个原子的透明度。
   *
   * 只改 style.opacity：一增删节点，后面的项就会挪位，观众看到的是"公式在跳"。
   * 原子数与可见数由 formulas.ts 的纯函数给（那里有单测），这里只负责落地。
   */
  private applyFormulaReveal(): void {
    for (const atoms of this.mathBlocks) {
      atoms.forEach((atom, index) => {
        atom.style.opacity = String(atomOpacity(index, this.local, atoms.length));
      });
    }
  }

  private applyChannels(): void {
    const cues = this.channels[this.index] ?? [];
    if (cues.length === 0) {
      for (const cue of cues) {
      if (cue.kind !== "state") continue;
      const node = this.countNodes.get(cue.target);
      // 只改文字内容：重排版要重解场景，而这件事每帧都要做
      if (node) node.textContent = String(Math.round(stateValueAt(cue, this.local)));
    }

    if (this.annotation) {
        for (const node of this.annotation.nodes) node.setAttribute("opacity", "0");
      }
      return;
    }
    const intensities = intensityAt(cues, this.local);
    // 只有**此刻真的在强调**时才压暗其他组。用"存在 spotlight 通道"来判断会出错：
    // 脉冲结束之后所有组仍然是暗的，整拍后半段都像被蒙了一层。
    const spotlighting = cues.some(
      (c) => c.kind === "spotlight" && intensities.get(c.target) !== undefined,
    );

    for (const cue of cues) {
      if (cue.kind !== "state") continue;
      const node = this.countNodes.get(cue.target);
      // 只改文字内容：重排版要重解场景，而这件事每帧都要做
      if (node) node.textContent = String(Math.round(stateValueAt(cue, this.local)));
    }

    if (this.annotation) {
      const strength = intensities.get(this.annotation.cue.target) ?? 0;
      for (const node of this.annotation.nodes) node.setAttribute("opacity", strength.toFixed(3));
    }

    for (const [id, nodes] of this.groupNodes) {
      const reveal = cues.find((c) => c.kind === "reveal" && c.target === id);
      const spotted = intensities.get(id) !== undefined;

      let opacity = 1;
      if (reveal) {
        opacity = revealOpacityAt(reveal, this.local);
      } else if (spotlighting) {
        // 有 spotlight 的拍里，没被点到的组压暗但不消失——它们仍在论证里
        opacity = spotted ? 1 : 0.45;
      }

      for (const node of nodes) node.setAttribute("opacity", opacity.toFixed(3));
    }
  }

  /**
   * 某一拍里每个单位的落点（屏幕坐标）。纯计算，用于转场插值的目标端。
   *
   * 缓存键带上画布高度：`fitHeight` 会按内容改变高度，高度一变，
   * 同一拍的落点也跟着变，拿旧缓存去插值就是让单位飞向一个不存在的位置。
   */
  private targetsOf(beatIndex: number): { units: Map<string, Point>; bars: Map<string, BarGeometry> } {
    const key = `${beatIndex}@${this.height}`;
    const cached = this.posCache.get(key);
    if (cached) return cached;

    const units = new Map<string, Point>();
    const bars = new Map<string, BarGeometry>();
    const beat = this.beats[beatIndex];
    if (beat) {
      const scene = solveScene(beat, this.width, this.height, 600, this.visuals);
      const top = scene.coords ? Math.round(this.height * 0.62) : 34;
      const bottom = FACTS_H + (this.subSteps > 0 ? TALLY_H : 0);
      const { items } = layoutFlowed(scene, { width: this.width, height: this.height, top, bottom });
      for (const item of items) {
        if (item.kind === "units") {
          for (const u of item.units) units.set(u.id, { x: u.cx, y: u.cy });
        } else if (item.kind === "bar") {
          bars.set(item.id, { x: item.box.x, y: item.box.y, w: item.box.w, h: item.box.h, fillW: item.fillW });
        }
      }
    }
    const out = { units, bars };
    this.posCache.set(key, out);
    return out;
  }

  /**
   * 进入一拍时停在起点（一只都没换），等学生自己拨。
   *
   * 曾经在这里自动逐只放一遍。既然已经可以拨了，自动播放就是在替学生做主：
   * 动画放完他只是"看过"，手拨一遍才是"试过"。假设法的道理在「多换一只会怎样」，
   * 那是个只有手能回答的问题。
   */
  private startSubPlayback(): void {
    this.subK = 0;
    this.motion = null;
    this.render();
  }

  /** 拨到第 k 只 */
  private scrubTo(k: number): void {
    this.subK = Math.max(0, Math.min(this.subSteps, Math.round(k)));
    this.motion = null;
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.pause();
    if (this.root.parentNode === this.container) this.container.removeChild(this.root);
  }

  /**
   * 时间驱动的播放循环：每帧把「过了多少毫秒」交给播放头，而不是等一个固定时长的定时器。
   *
   * 换掉 setTimeout 的理由不是审美：定时器的误差会一直累积（每拍迟几十毫秒，
   * 二十拍后就是一两秒），而且它没法表达"跳到第 7.3 秒"——
   * 而 seek、字幕轨对时、断点续看都要求画面是 t 的函数。
   */
  private scheduleTick(): void {
    if (!this.playing) return;
    this.raf = this.clock.schedule(() => {
      this.raf = null;
      if (!this.playing || this.destroyed) return;
      const now = this.clock.now();
      const dt = now - this.lastTickMs;
      this.lastTickMs = now;
      this.applyFrame(this.playhead.advance(dt));
      if (this.playhead.finished) {
        this.playing = false;
        this.syncControls();
        return;
      }
      this.scheduleTick();
    });
  }

  // ── 渲染 ───────────────────────────────────────────────

  /** 纯数量画面时按内容需要的高度撑开画布——缩小记号不是解决重叠的办法 */
  private fitHeight(scene: Scene, top: number, bottom: number): void {
    if (scene.coords) return; // 有数学图时坐标系已定高，不动
    const probe = layoutFlowed(scene, { width: this.width, height: 4000, top, bottom });
    const needed = Math.ceil(top + probe.usedHeight + bottom);
    const next = Math.max(380, Math.min(1100, needed));
    if (next === this.height) return;
    this.height = next;
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
  }

  private render(): void {
    const beat = this.beats[this.index];
    if (!beat) return;
    const full = solveScene(beat, this.width, this.height, 600, this.visuals);
    this.subSteps = swappedCount(full);
    // 可回放的那一拍按当前进度只换前 k 只；其余拍照常整幅渲染
    let scene = this.subSteps > 0 ? limitSwaps(full, this.subK) : full;
    // 拨动时依赖它的量要跟着动：多画一根同尺子的「现在」条，
    // 它从假设值一路长到实际值。否则上面那两根静态的条纹丝不动，
    // 过程就只剩下换颜色，看不出因果。
    this.live = this.subSteps > 0 ? liveTotal(scene, this.subK) : undefined;
    if (this.live) scene = withLiveBar(scene, this.live, "现在");

    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    this.svg.setAttribute("aria-label", beat.teachingLine ?? `第 ${this.index + 1} 拍`);

    // 数学图：坐标系 + 图元（同一个 toScreen）
    if (scene.coords) {
      this.drawAxes(scene.coords);
      for (const s of scene.plotted) this.drawPlotted(s, scene.coords);
    }
    // 数量记号：可数、能飞
    this.drawFlowed(scene);
    this.drawFacts(scene);
    if (this.subSteps > 0) this.drawTally(scene);

    this.caption.textContent = scene.teachingLine ?? "";
    this.reportIssues(scene.issues);
    this.opts.onBeatChange?.(this.index, this.beatCount);
    this.syncControls();
  }

  private drawAxes(cs: CoordSystem): void {
    const g = el("g");
    const [x0, y0] = cs.toScreen(cs.viewport.xMin, 0);
    const [x1] = cs.toScreen(cs.viewport.xMax, 0);
    const [, yTop] = cs.toScreen(0, cs.viewport.yMax);
    const [xLeft, yBot] = cs.toScreen(0, cs.viewport.yMin);

    for (const t of cs.xTicks) {
      const [tx] = cs.toScreen(t, 0);
      g.appendChild(el("line", { x1: tx, y1: yTop, x2: tx, y2: yBot, stroke: C.rule, "stroke-width": 1 }));
      const label = el("text", {
        x: tx, y: Math.min(yBot - 4, y0 + 14), "text-anchor": "middle",
        "font-size": 10, fill: C.inkFaint, "font-family": "ui-monospace,monospace",
      });
      label.textContent = String(t);
      if (t !== 0) g.appendChild(label);
    }
    for (const t of cs.yTicks) {
      const [, ty] = cs.toScreen(0, t);
      g.appendChild(el("line", { x1: x0, y1: ty, x2: x1, y2: ty, stroke: C.rule, "stroke-width": 1 }));
      const label = el("text", {
        x: Math.max(x0 + 4, xLeft - 6), y: ty + 3, "text-anchor": "end",
        "font-size": 10, fill: C.inkFaint, "font-family": "ui-monospace,monospace",
      });
      label.textContent = String(t);
      if (t !== 0) g.appendChild(label);
    }
    // 轴线（原点存在时画在 0 上，否则贴边）
    g.appendChild(el("line", { x1: x0, y1: y0, x2: x1, y2: y0, stroke: C.ink, "stroke-width": 1.5 }));
    g.appendChild(el("line", { x1: xLeft, y1: yTop, x2: xLeft, y2: yBot, stroke: C.ink, "stroke-width": 1.5 }));
    this.svg.appendChild(g);
  }

  private drawPlotted(s: Shape, cs: CoordSystem): void {
    switch (s.kind) {
      case "curve": {
        for (const seg of s.segments) {
          if (seg.length < 2) continue;
          const d = seg
            .map((q, i) => {
              const [x, y] = cs.toScreen(q[0], q[1]);
              return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
            })
            .join(" ");
          const path = el("path", {
            d, fill: "none",
            stroke: s.role === "primary" ? C.ink : C.inkFaint,
            "stroke-width": s.role === "primary" ? 2.4 : 1.6,
            "stroke-linecap": "round", "stroke-linejoin": "round",
          }) as SVGPathElement;
          this.svg.appendChild(path);
          this.traceIn(path);
        }
        if (s.label) this.drawTag(s.label, cs, s.segments, C.ink);
        break;
      }
      case "segment": {
        const [ax, ay] = cs.toScreen(s.from[0], s.from[1]);
        const [bx, by] = cs.toScreen(s.to[0], s.to[1]);
        const stroke = s.role === "tangent" ? C.lit : s.role === "secant" ? C.beam : C.inkFaint;
        const line = el("line", {
          x1: ax, y1: ay, x2: bx, y2: by, stroke,
          "stroke-width": s.role === "tangent" ? 2.6 : 2,
          ...(s.role === "guide" ? { "stroke-dasharray": "4 4" } : {}),
        });
        this.svg.appendChild(line);
        if (s.role === "arrow") {
          const ang = Math.atan2(by - ay, bx - ax);
          const head = el("polygon", {
            points: `${bx},${by} ${bx - 7 * Math.cos(ang - 0.4)},${by - 7 * Math.sin(ang - 0.4)} ${bx - 7 * Math.cos(ang + 0.4)},${by - 7 * Math.sin(ang + 0.4)}`,
            fill: C.inkFaint,
          });
          this.svg.appendChild(head);
        }
        if (s.slope !== undefined || s.label) {
          const t = el("text", {
            x: (ax + bx) / 2 + 6, y: (ay + by) / 2 - 6, "font-size": 11,
            fill: stroke, "font-family": "ui-monospace,monospace",
          });
          t.textContent = s.label ?? `斜率 ${s.slope!.toFixed(2)}`;
          this.svg.appendChild(t);
        }
        break;
      }
      case "point": {
        const [x, y] = cs.toScreen(s.at[0], s.at[1]);
        const fill = s.role === "root" ? C.lit : s.role === "limit" ? C.beam : C.beam;
        this.svg.appendChild(
          el("circle", {
            cx: x, cy: y, r: s.role === "sample" ? 3 : 4.5,
            fill: s.open ? "#fff" : fill, stroke: fill, "stroke-width": 2,
          }),
        );
        if (s.label) {
          const t = el("text", { x: x + 8, y: y - 8, "font-size": 11, fill: C.ink });
          t.textContent = s.label;
          this.svg.appendChild(t);
        }
        break;
      }
      case "rects": {
        for (const [l, r, h] of s.rects) {
          const [lx, hy] = cs.toScreen(l, h);
          const [rx, zy] = cs.toScreen(r, 0);
          this.svg.appendChild(
            el("rect", {
              x: Math.min(lx, rx), y: Math.min(hy, zy),
              width: Math.abs(rx - lx), height: Math.abs(zy - hy),
              fill: C.beam, "fill-opacity": 0.16, stroke: C.beam, "stroke-width": 1,
            }),
          );
        }
        if (s.approxArea !== undefined) {
          const t = el("text", { x: 12, y: 20, "font-size": 12, fill: C.beam, "font-family": "ui-monospace,monospace" });
          t.textContent = `${s.rects.length} 个矩形，面积和 ≈ ${s.approxArea.toFixed(3)}`;
          this.svg.appendChild(t);
        }
        break;
      }
      default:
        break;
    }
  }

  /** 曲线逐段描出：让"曲线是怎么长出来的"可见 */
  private traceIn(path: SVGPathElement): void {
    if (reduceMotion() || typeof path.getTotalLength !== "function") return;
    let len = 0;
    try {
      len = path.getTotalLength();
    } catch {
      return;
    }
    if (!Number.isFinite(len) || len <= 0) return;
    /*
     * 这里曾经做"曲线画入"：先设 strokeDashoffset = 全长，再用 WAAPI 在 900ms 内归零。
     * 那是墙上时钟的动画，与 t 无关——同一时刻截两次图会得到不同的像素，
     * 而阶段 2 的 DoD 要的正是"同一 t 必得同一画面"。所以删掉。
     *
     * 曲线画入这件事本身没错，但它该由**动作通道**在时间轴上驱动（谁在第几拍出现、
     * 用多长时间露出），而不是渲染完顺手起一个动画。等 reveal 通道落地再回来做。
     */
    void len;
  }

  private drawTag(text: string, cs: CoordSystem, segs: [number, number][][], fill: string): void {
    const last = segs[segs.length - 1];
    const p = last?.[Math.floor((last.length - 1) * 0.75)];
    if (!p) return;
    const [x, y] = cs.toScreen(p[0], p[1]);
    const t = el("text", { x: x + 6, y: y - 8, "font-size": 12, fill, "font-family": "ui-monospace,monospace" });
    t.textContent = text;
    this.svg.appendChild(t);
  }

  /**
   * 数量画面：坐标全部来自 render/layout.ts（可单测的纯函数），这里只负责涂色。
   * 同一单位跨拍飞行（守恒可见）；组的形状与颜色由通道决定，跨拍稳定。
   */
  private drawFlowed(scene: Scene): void {
    if (scene.flowed.length === 0) return;

    // 有数学图时，数量画面缩到下方；否则占满画布
    const top = scene.coords ? Math.round(this.height * 0.62) : 34;
    // 有实时读数时必须把它那一行也让出来，否则读数会压在记号上
    const bottom = FACTS_H + (this.subSteps > 0 ? TALLY_H : 0);
    this.fitHeight(scene, top, bottom);
    const { items } = layoutFlowed(scene, {
      width: this.width,
      height: this.height,
      top,
      bottom,
    });
    const nextPos = new Map<string, { x: number; y: number }>();

    this.groupNodes.clear();
    this.countNodes.clear();
    this.mathBlocks = [];
    for (const item of items) {
      /*
       * 按组收集刚画出来的节点：通道要靠改透明度生效，每帧重建整幅画面太贵
       * （一拍里几十帧，每帧都要重解场景、重排版）。用"画前画后的子元素差"来收，
       * 比在每个绘制函数里手工 push 更不容易漏。
       */
      const before = this.svg.childElementCount;
      if (item.kind === "bar") this.paintBar(item);
      else if (item.kind === "extent") this.paintExtent(item);
      else if (item.kind === "label") this.paintLabel(item);
      else if (item.kind === "sentence") this.paintSentence(item);
      else if (item.kind === "card") this.paintCard(item);
      else if (item.kind === "figure") this.paintFigure(item);
      else this.paintUnits(item, nextPos);
      this.groupNodes.set(
        item.id,
        Array.from(this.svg.children).slice(before) as SVGElement[],
      );
      const box = "box" in item ? item.box : "at" in item ? { ...item.at, w: 0, h: 0 } : undefined;
      if (box) this.groupBoxes.set(item.id, box);
    }
    this.drawAnnotation();
    this.applyFormulaReveal();
    this.applyChannels();

  }

  /**
   * 量：长度正比于数值的条。共享一把尺，差额那一截高亮——「差 24」是看出来的。
   *
   * 转场时插的是**几何**（槽位 + 填充长度），不是数值：所有条共享一把尺，
   * 而尺本身会随全场最大值变；去插数值再按新尺换算，中途会出现
   * "数值没动、条却跳了一下"的怪相。读数是文字，哪一拍的写哪一拍的，不补间。
   *
   * 需要知道的一件事：**当前模型里条根本不会跨拍变化**。
   * `magnitude` 在 fold 建组时从 params 读一次，之后没有任何动作会改它
   * （take_from 改的是 units，平衡类动作改的是 live 值，都不落在 magnitude 上）。
   * 所以这段补间目前是"接通但待机"：写好了、纯函数测过，等哪天有动作能改条的量，
   * 它立刻生效。要让数量条随叙事变长变短，缺的是**动作**（例如 set_value），不是播放器。
   *
   * 刻度按填充宽度的比例压缩：一轮转场里刻度数不变、间距等比缩，
   * 转场结束才换成下一拍那组。刻度的语义是"单位分格"，单位数本来就会变，
   * 追求逐刻度连续既做不到也没意义。
   */
  private paintBar(bar: PlacedBar): void {
    const tone = CHANNELS[bar.channel % CHANNELS.length]!;
    const target = this.motion?.bars.get(bar.id);
    const geom: BarGeometry = target
      ? tweenBarGeometry(
          { x: bar.box.x, y: bar.box.y, w: bar.box.w, h: bar.box.h, fillW: bar.fillW },
          target,
          this.motion!.progress,
        )
      : { x: bar.box.x, y: bar.box.y, w: bar.box.w, h: bar.box.h, fillW: bar.fillW };
    const box = { x: geom.x, y: geom.y, w: geom.w, h: geom.h };
    const fillW = geom.fillW;
    // 刻度与差额段都是相对槽位左侧的偏移：随填充一起等比压缩，才不会被留在框外
    const tickScale = bar.fillW > 0 ? fillW / bar.fillW : 1;
    this.maybeMath(bar.label ?? bar.id, bar.labelAt.x, bar.labelAt.y, 12, C.ink, "start", 600);
    // 空槽：让所有条的量程一致，短的那根一眼看出"还差一截"
    this.svg.appendChild(
      el("rect", {
        x: box.x, y: box.y, width: box.w, height: box.h, rx: 6,
        fill: "none", stroke: C.rule, "stroke-width": 1,
      }),
    );
    const fill = el("rect", {
      x: box.x, y: box.y, width: Math.max(0, fillW), height: box.h, rx: 6,
      fill: tone, "fill-opacity": 0.22, stroke: tone, "stroke-width": 1.5,
    });
    this.svg.appendChild(fill);
    for (const t of bar.ticks) {
      this.svg.appendChild(
        el("line", {
          x1: box.x + t * tickScale, y1: box.y + 6,
          x2: box.x + t * tickScale, y2: box.y + box.h - 6,
          stroke: tone, "stroke-width": 1, "stroke-opacity": 0.45,
        }),
      );
    }
    // 数值写在填充段内侧；条太短就挪到外面，绝不压在边框上
    const inside = fillW > 46;
    const valueNode = this.text(
      String(bar.value),
      box.x + fillW + (inside ? -10 : 8),
      box.y + box.h / 2 + 4,
      13,
      tone,
      inside ? "end" : "start",
      700,
    );
    this.countNodes.set(bar.id, valueNode);
    if (bar.delta) {
      const w = (bar.delta.toX - bar.delta.fromX) * tickScale;
      this.svg.appendChild(
        el("rect", {
          x: box.x + bar.delta.fromX * tickScale, y: box.y - 4, width: w, height: box.h + 8, rx: 4,
          fill: C.beam, "fill-opacity": 0.12, stroke: C.beam,
          "stroke-width": 1.5, "stroke-dasharray": "5 3",
        }),
      );
      // 「比最短的那根多出 N」——写「差 N」在三根条并排时会被读成缺口
      this.text(
        `+${bar.delta.value}`,
        box.x + bar.delta.fromX * tickScale + w / 2,
        box.y - 9, 12, C.beam, "middle", 700,
      );
    }
  }

  /** 声明了宽高的矩形：按长宽比画出来，不降级成一行字 */
  private paintExtent(ext: PlacedExtent): void {
    const tone = CHANNELS[ext.channel % CHANNELS.length]!;
    this.text(ext.label ?? ext.id, ext.labelAt.x, ext.labelAt.y, 12, C.ink, "start", 600);
    this.svg.appendChild(
      el("rect", {
        x: ext.box.x, y: ext.box.y, width: ext.box.w, height: ext.box.h, rx: 4,
        fill: tone, "fill-opacity": 0.14, stroke: tone, "stroke-width": 1.5,
      }),
    );
  }

  /**
   * 讲义原图（转写重画）：走 figure/render 的保形投影，嵌套 <svg> 放进布局框。
   * 不用 SceneSpec 的坐标系画它——那套 x/y 独立缩放，几何图会被拉伸说谎。
   */
  private paintFigure(item: PlacedFigure): void {
    const spec: FigureSpec = {
      points: item.shape.points.map((p) => ({ id: p.id })),
      segments: item.shape.segments.map((s) => ({
        from: s.from,
        to: s.to,
        style: "solid" as const,
        ...(s.label !== undefined ? { label: s.label } : {}),
      })),
      polygons: item.shape.polygons.map((p) => ({
        points: p.points,
        shaded: p.shaded,
        ...(p.label !== undefined ? { label: p.label } : {}),
        ...(p.tone !== undefined ? { tone: p.tone } : {}),
        ...(p.pair !== undefined ? { pair: p.pair } : {}),
      })),
      circles: [],
      angles: [],
      equal_marks: item.shape.equalMarks.map((m) => ({
        a: m.a,
        b: m.b,
        ...(m.label !== undefined ? { label: m.label } : {}),
        ...(m.tone !== undefined ? { tone: m.tone } : {}),
      })),
      constraints: [],
    };
    const coords = Object.fromEntries(
      item.shape.points.map((p) => [p.id, { x: p.at[0], y: p.at[1] }]),
    );
    // 内部宽度取布局框宽：字号/线宽按这个尺度出，再由嵌套 svg 等比适配
    const rendered = renderSolved(spec, coords, { width: Math.max(160, Math.round(item.box.w)) });
    const holder = el("g");
    holder.innerHTML = rendered.svg;
    const inner = holder.firstElementChild;
    if (!(inner instanceof SVGElement)) return;
    inner.setAttribute("x", String(item.box.x));
    inner.setAttribute("y", String(item.box.y));
    inner.setAttribute("width", String(item.box.w));
    inner.setAttribute("height", String(item.box.h));
    inner.setAttribute("viewBox", `0 0 ${rendered.width} ${rendered.height}`);
    inner.setAttribute("preserveAspectRatio", "xMidYMid meet");
    if (item.emphasis) inner.setAttribute("opacity", "1");
    this.svg.appendChild(inner);
  }

  private paintLabel(l: PlacedLabel): void {
    this.text(
      l.placeholder ? `［${l.text}］` : l.text,
      l.at.x, l.at.y, 12, l.placeholder ? C.inkFaint : C.ink, "start", 400,
    );
  }

  /**
   * 英语句子：整句居中，正在练的那一段加底色并加粗。
   *
   * 高亮只用**原文里的字符区间**（布局层算好的），所以句子里本来有的撇号、
   * 省略号都原样保留；找不到那一段就整句平着画，绝不去猜"大概是这个"。
   */
  private paintSentence(s: PlacedSentence): void {
    const cx = s.box.x + s.box.w / 2;
    const t = el("text", {
      x: cx,
      y: s.baseline,
      "font-size": s.fontSize,
      fill: C.ink,
      "text-anchor": "middle",
      "font-family": "Georgia, 'Times New Roman', serif",
    }) as SVGTextElement;

    const spans = [...s.highlights].sort((a, b) => a.start - b.start);
    let at = 0;
    const add = (piece: string, strong: boolean): void => {
      if (!piece) return;
      const ts = el("tspan", strong ? { "font-weight": 700, fill: C.beam } : {}) as SVGTSpanElement;
      ts.textContent = piece;
      if (strong) ts.setAttribute("text-decoration", "underline");
      t.appendChild(ts);
    };
    for (const span of spans) {
      if (span.start < at || span.end > s.text.length) continue; // 区间重叠/越界：跳过，不猜
      add(s.text.slice(at, span.start), false);
      add(s.text.slice(span.start, span.end), true);
      at = span.end;
    }
    add(s.text.slice(at), false);
    this.svg.appendChild(t);
  }

  /** 词汇卡：正面词 + 背面释义，卡片边框只围住这一张卡，不做装饰 */
  private paintCard(c: PlacedCard): void {
    const g = el("g");
    g.appendChild(
      el("rect", {
        x: c.box.x + 8,
        y: c.box.y,
        width: Math.max(0, c.box.w - 16),
        height: c.box.h,
        rx: 14,
        fill: C.paper,
        stroke: C.rule,
        "stroke-width": 1.5,
      }),
    );
    const cx = c.box.x + c.box.w / 2;
    const head = el("text", {
      x: cx, y: c.headBaseline, "font-size": c.headSize, fill: C.beam,
      "text-anchor": "middle", "font-weight": 600,
      "font-family": "Georgia, 'Times New Roman', serif",
    }) as SVGTextElement;
    head.textContent = c.head;
    g.appendChild(head);
    if (c.sub !== undefined && c.subBaseline !== undefined) {
      const sub = el("text", {
        x: cx, y: c.subBaseline, "font-size": c.subSize, fill: C.ink,
        "text-anchor": "middle",
      }) as SVGTextElement;
      sub.textContent = c.sub;
      g.appendChild(sub);
    }
    this.svg.appendChild(g);
  }

  /** 集：可数的记号。组身份 = 形状 × 颜色，被换过类别的记号换形状但不换位置 */
  /**
   * 画一段可能含公式的文字。
   *
   * `$...$` 里是 LaTeX：有渲染器就交给它（塞进 foreignObject，SVG 里能放 HTML），
   * 没有就原样画成文字。**不做半吊子替换**——把 `$x^2$` 的美元符号去掉、
   * 上下标丢掉，比原样显示更难查。
   */
  private maybeMath(
    content: string,
    x: number,
    y: number,
    size: number,
    fill: string,
    anchor: "start" | "middle" | "end" = "start",
    weight = 400,
  ): void {
    const tex = /\$([^$]+)\$/.exec(content)?.[1];
    if (!tex || !this.opts.math) {
      this.text(content, x, y, size, fill, anchor, weight);
      return;
    }
    const rendered = this.opts.math(tex, false);
    rendered.root.style.fontSize = `${size}px`;
    rendered.root.style.display = "inline-block";
    const fo = document.createElementNS(NS, "foreignObject");
    fo.setAttribute("x", String(x));
    // foreignObject 的 y 是顶边，而 svg text 的 y 是基线：按字号抬一点，两者才对得齐
    fo.setAttribute("y", String(y - size));
    fo.setAttribute("width", String(Math.max(40, Math.min(this.width - x, 320))));
    fo.setAttribute("height", String(Math.ceil(size * 2.2)));
    fo.appendChild(rendered.root);
    this.svg.appendChild(fo);
    this.mathBlocks.push(rendered.atoms);
  }

  private paintUnits(g: PlacedUnits, nextPos: Map<string, { x: number; y: number }>): void {
    const tone = CHANNELS[g.channel % CHANNELS.length]!;
    const shape = SHAPES[g.channel % SHAPES.length]!;
    const count = g.units.reduce((s, u) => s + u.weight, 0);
    const head = g.label ?? g.id;
    this.maybeMath(
      `${head}${g.note ? `（${g.note}）` : ""}`,
      g.labelAt.x, g.labelAt.y, 12, g.ghost ? C.inkFaint : C.ink, "start", 600,
    );
    if (!g.label?.includes(String(count))) {
      const countNode = this.text(`${count}`, g.labelAt.x + g.box.w, g.labelAt.y, 12, C.inkFaint, "end", 600);
      this.countNodes.set(g.id, countNode);
    }

    for (const u of g.units) {
      // 本拍的落点记下来（拨动滑杆、同一拍重绘都要用它当基准）
      nextPos.set(u.id, { x: u.cx, y: u.cy });
      /*
       * 转场中：位置按进度插值，而不是让 CSS 自己动。
       * 由 t 算出来的位置，seek 到任意时刻都对得上；CSS 动画一旦被打断，
       * 画面就停在"当时是什么样"，而那个"当时"谁也复现不出来。
       */
      const target = this.motion?.positions.get(u.id);
      const at = target
        ? tweenPoint({ x: u.cx, y: u.cy }, target, this.motion!.progress)
        : { x: u.cx, y: u.cy };
      // 被替换过的记号长成它变成的那一类的样子（换成兔就该像兔）；
      // spec 没说变成什么时退到下一个通道，至少和原类别区分得开
      const swappedCh = u.swappedChannel ?? (g.channel + 1) % CHANNELS.length;
      const swappedTone = CHANNELS[swappedCh % CHANNELS.length]!;
      const node = this.unitNode(
        u.swapped ? SHAPES[swappedCh % SHAPES.length]! : shape,
        at.x, at.y, u.r,
        g.ghost ? "none" : u.swapped ? swappedTone : u.kind === "unknown" ? C.lit : tone,
        g.ghost ? C.inkFaint : u.swapped ? swappedTone : tone,
        g.ghost,
      );
      this.svg.appendChild(node);
      // 垂下的附属记号：挂在这个单位身上，跟着它一起走
      if (u.markXs && u.markLen) {
        for (const dx of u.markXs) {
          this.svg.appendChild(
            el("line", {
              x1: at.x + dx, y1: at.y + u.r * 0.8,
              x2: at.x + dx, y2: at.y + u.r * 0.8 + u.markLen,
              stroke: u.swapped ? swappedTone : tone,
              "stroke-width": Math.max(1, u.r * 0.22),
              "stroke-linecap": "round",
            }),
          );
        }
      }
      if (u.weight > 1) {
        this.text(String(u.weight), at.x, at.y + u.r * 0.45, Math.max(7, u.r), "#fff", "middle", 700);
      }
    }
  }

  /**
   * 实时读数：个体多少、附属记号多少。
   *
   * 不写「头」「脚」这种词——播放器不知道题目在讲什么，写死就成了特判。
   * 改成画两个小图例：一个圆点配个体数，一根竖线配记号数，
   * 与上面的画面用同一套形状说话。拨动滑杆时前者纹丝不动、后者一路爬升，
   * 「什么变、什么不变」不用解释就看见了。
   */
  private drawTally(scene: Scene): void {
    const { units, marks } = unitTotals(scene);
    if (units <= 0) return;
    const y = this.height - FACTS_H - TALLY_H / 2;
    let x = 24;

    const chip = (draw: (cx: number, cy: number) => void, value: number, width: number) => {
      draw(x + 7, y);
      this.text(String(value), x + 18, y + 5, 14, C.ink, "start", 700);
      x += width;
    };

    chip(
      (cx, cy) => this.svg.appendChild(el("circle", { cx, cy, r: 6, fill: CHANNELS[0]!, "fill-opacity": 0.85 })),
      units,
      34 + String(units).length * 9,
    );
    if (marks !== undefined && marks > 0) {
      chip(
        (cx, cy) => {
          for (const dx of [-3, 3]) {
            this.svg.appendChild(
              el("line", {
                x1: cx + dx, y1: cy - 6, x2: cx + dx, y2: cy + 6,
                stroke: CHANNELS[0]!, "stroke-width": 2, "stroke-linecap": "round",
              }),
            );
          }
        },
        marks,
        34 + String(marks).length * 9,
      );
    }
    if (this.live && marks === undefined) {
      // 记号数说不清时，用声明推出来的「现在」值补位（来源不同，但同样有据）
      this.text(
        `${Math.round(this.live.from)} → ${Math.round(this.live.value)}`,
        x + 6, y + 5, 14, C.beam, "start", 700,
      );
      x += 96;
    }
    if (this.subSteps > 0) {
      this.text(`已换 ${this.subK} / ${this.subSteps}`, x + 6, y + 5, 12, C.inkFaint, "start", 600);
    }
  }

  /** 形状通道：颜色之外再给一条区分维度（色觉障碍与灰度打印下仍分得清） */
  private unitNode(
    shape: UnitShape,
    cx: number,
    cy: number,
    r: number,
    fill: string,
    stroke: string,
    ghost = false,
  ): SVGElement {
    const common = {
      fill,
      "fill-opacity": ghost ? 0 : 0.85,
      stroke,
      "stroke-width": 1,
      "stroke-dasharray": ghost ? "2 2" : "0",
    };
    if (shape === "square") {
      return el("rect", { x: cx - r, y: cy - r, width: r * 2, height: r * 2, rx: r * 0.3, ...common });
    }
    if (shape === "triangle") {
      const pts = `${cx},${cy - r} ${cx + r},${cy + r * 0.8} ${cx - r},${cy + r * 0.8}`;
      return el("polygon", { points: pts, ...common });
    }
    if (shape === "diamond") {
      const pts = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
      return el("polygon", { points: pts, ...common });
    }
    return el("circle", { cx, cy, r, ...common });
  }

  private text(
    content: string,
    x: number,
    y: number,
    size: number,
    fill: string,
    anchor: "start" | "middle" | "end" = "start",
    weight = 400,
  ): SVGTextElement {
    const t = el("text", {
      x, y, "font-size": size, fill, "text-anchor": anchor, "font-weight": weight,
    }) as SVGTextElement;
    t.textContent = content;
    this.svg.appendChild(t);
    return t;
  }

  /**
   * 计数事实与守恒：一致就安静，不一致必须显眼——这正是验算的价值。
   * 画在底部自己的条里（布局层已为它留了 FACTS_H），绝不压在内容上。
   */
  private drawFacts(scene: Scene): void {
    const facts: { text: string; ok: boolean }[] = [];
    for (const c of scene.counts) {
      const ok = c.claimed === c.actual;
      facts.push({
        text: ok ? `数一遍：${c.actual} ✓` : `说是 ${c.claimed}，数出来 ${c.actual} ✗`,
        ok,
      });
    }
    if (scene.conservation) {
      const { before, after, ok } = scene.conservation;
      facts.push({
        text: ok ? `总数没变：${before} → ${after} ✓` : `总数对不上：${before} → ${after} ✗`,
        ok,
      });
    }
    if (scene.equality) {
      const { left, right, ok } = scene.equality;
      facts.push({ text: `${left} ${ok ? "=" : "≠"} ${right}`, ok });
    }
    if (facts.length === 0) return;

    const stripY = this.height - FACTS_H;
    this.svg.appendChild(
      el("line", {
        x1: 20, y1: stripY, x2: this.width - 20, y2: stripY,
        stroke: C.rule, "stroke-width": 1,
      }),
    );
    let x = 24;
    for (const f of facts) {
      const t = el("text", {
        x, y: stripY + 22, "font-size": 12,
        fill: f.ok ? C.correct : C.wrong, "font-family": "ui-monospace,monospace",
      });
      t.textContent = f.text;
      this.svg.appendChild(t);
      // 等宽字体下按字符数估宽足够稳；条目少，不值得为此做一次 DOM 测量
      x += f.text.length * 7.6 + 26;
    }
  }

  private reportIssues(issues: SceneIssue[]): void {
    const uncomputable = issues.filter((i) => i.kind === "uncomputable-curve");
    if (uncomputable.length > 0) {
      this.notice.style.display = "block";
      this.notice.textContent = `这条曲线没能算出来：${uncomputable[0]!.detail}`;
    } else {
      this.notice.style.display = "none";
      this.notice.textContent = "";
    }
    for (const issue of issues) {
      const key = `${issue.kind}:${issue.objectId}:${issue.detail}`;
      if (this.reportedIssues.has(key)) continue;
      this.reportedIssues.add(key);
      this.opts.onIssue?.(issue);
    }
  }

  // ── 控制条 ─────────────────────────────────────────────

  private buildControls(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;font-size:13px";
    const mk = (text: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.style.cssText = `padding:4px 10px;border:1px solid ${C.rule};border-radius:8px;background:#fff;color:${C.ink};cursor:pointer`;
      b.addEventListener("click", fn);
      return b;
    };
    const prev = mk("上一拍", () => this.prev());
    const toggle = mk("播放", () => (this.playing ? this.pause() : this.play()));
    const next = mk("下一拍", () => this.next());
    const pos = document.createElement("span");
    pos.style.cssText = `color:${C.inkFaint};font-family:ui-monospace,monospace`;

    // 可回放的那一拍给一根滑杆：让学生自己拨「换了几只」。
    // 看演示和自己动手是两回事——假设法的"每换一只多两根"，手拨一遍就懂了。
    const scrub = document.createElement("input");
    scrub.type = "range";
    scrub.min = "0";
    scrub.step = "1";
    scrub.setAttribute("aria-label", "换了几只");
    scrub.style.cssText = "flex:1;min-width:80px;max-width:220px;accent-color:" + C.beam;
    scrub.addEventListener("input", () => this.scrubTo(Number(scrub.value)));
    this.scrubEl = scrub;

    bar.append(prev, toggle, next, scrub, pos);
    this.controlsEl = bar;
    (bar as HTMLDivElement & { _toggle?: HTMLButtonElement })._toggle = toggle;
    (bar as HTMLDivElement & { _pos?: HTMLSpanElement })._pos = pos;
    return bar;
  }

  private syncControls(): void {
    // 滑杆只在能拨的那一拍出现；这时藏掉「播放」——
    // 自动翻拍会把学生正在拨的画面翻走，两个控制权抢同一件事
    if (this.scrubEl) {
      const scrubbable = this.subSteps > 0;
      this.scrubEl.style.display = scrubbable ? "" : "none";
      this.scrubEl.max = String(Math.max(1, this.subSteps));
      this.scrubEl.value = String(this.subK);
      const toggle = (this.controlsEl as (HTMLDivElement & { _toggle?: HTMLButtonElement }) | null)
        ?._toggle;
      if (toggle) toggle.style.display = scrubbable ? "none" : "";
      if (scrubbable && this.playing) this.pause();
    }
    const bar = this.controlsEl as (HTMLDivElement & { _toggle?: HTMLButtonElement; _pos?: HTMLSpanElement }) | null;
    if (!bar) return;
    if (bar._toggle) bar._toggle.textContent = this.playing ? "暂停" : "播放";
    if (bar._pos) bar._pos.textContent = `${this.index + 1} / ${this.beatCount}`;
  }
}
