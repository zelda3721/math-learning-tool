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
import {
  limitSwaps,
  solveScene,
  swappedCount,
  unitTotals,
  type Scene,
  type SceneIssue,
  type Shape,
} from "./render/scene.js";
import {
  layoutFlowed,
  type PlacedBar,
  type PlacedExtent,
  type PlacedLabel,
  type PlacedUnits,
} from "./render/layout.js";
import type { CoordSystem } from "./math/coords.js";

export interface PlayerOptions {
  autoPlay?: boolean;
  beatMs?: number;
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

/** 右上角计数/守恒事实条占用的高度：内容区绝不侵占它（画面不许自己压自己） */
const FACTS_H = 58;

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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private playing = false;
  private destroyed = false;
  private width = 640;
  private height = 380;
  /** 上一拍每个单位的屏幕位置，用于 FLIP 飞行 */
  private lastUnitPos = new Map<string, { x: number; y: number }>();
  private reportedIssues = new Set<string>();
  /**
   * 本拍「已经换了几只」。假设法的道理不在终态而在过程——
   * 每换一只，个体数一个不变、记号数多两根。只给终态，这个因果就得靠脑补。
   */
  private subK = 0;
  private subSteps = 0;
  private subTimer: ReturnType<typeof setInterval> | null = null;
  private scrubEl: HTMLInputElement | null = null;

  constructor(container: HTMLElement, spec: SceneSpec, opts: PlayerOptions = {}) {
    this.container = container;
    this.opts = opts;
    this.beats = foldBeats(spec);
    this.beatCount = this.beats.length;

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

    this.render();
    if (opts.autoPlay) this.play();
  }

  // ── 播放控制 ───────────────────────────────────────────

  play(): void {
    if (this.destroyed || this.playing) return;
    this.playing = true;
    this.syncControls();
    this.schedule();
  }

  pause(): void {
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.syncControls();
  }

  next(): void {
    this.goTo(this.index + 1);
  }

  prev(): void {
    this.goTo(this.index - 1);
  }

  goTo(i: number): void {
    if (this.destroyed) return;
    const clamped = Math.max(0, Math.min(this.beatCount - 1, i));
    if (clamped === this.index) return;
    this.index = clamped;
    this.startSubPlayback();
    if (this.playing) this.schedule();
  }

  /**
   * 进入一拍时先把替换过程逐只放一遍，再停在终态。
   * 减少动效时直接给终态——不是省事，是那样的人本来就不该被动画牵着走。
   */
  private startSubPlayback(): void {
    if (this.subTimer) clearInterval(this.subTimer);
    this.subTimer = null;
    this.subK = 0;
    this.render();
    if (this.subSteps <= 0) return;
    if (reduceMotion()) {
      this.subK = this.subSteps;
      this.render();
      return;
    }
    // 总时长压在 2.4 秒内：换得再多也不该让人干等
    const step = Math.max(70, Math.min(220, Math.round(2400 / this.subSteps)));
    this.subTimer = setInterval(() => {
      if (this.destroyed || this.subK >= this.subSteps) {
        if (this.subTimer) clearInterval(this.subTimer);
        this.subTimer = null;
        return;
      }
      this.subK += 1;
      this.render();
    }, step);
  }

  /** 手动拨到第 k 只（滑杆）：拨动时停掉自动回放，交还控制权 */
  private scrubTo(k: number): void {
    if (this.subTimer) clearInterval(this.subTimer);
    this.subTimer = null;
    this.subK = Math.max(0, Math.min(this.subSteps, Math.round(k)));
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.subTimer) clearInterval(this.subTimer);
    this.subTimer = null;
    this.pause();
    if (this.root.parentNode === this.container) this.container.removeChild(this.root);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.index >= this.beatCount - 1) {
      this.playing = false;
      this.syncControls();
      return;
    }
    this.timer = setTimeout(() => {
      this.index += 1;
      this.render();
      this.schedule();
    }, this.opts.beatMs ?? 3200);
  }

  // ── 渲染 ───────────────────────────────────────────────

  private render(): void {
    const beat = this.beats[this.index];
    if (!beat) return;
    const full = solveScene(beat, this.width, this.height);
    this.subSteps = swappedCount(full);
    // 可回放的那一拍按当前进度只换前 k 只；其余拍照常整幅渲染
    const scene = this.subSteps > 0 ? limitSwaps(full, this.subK) : full;

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
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    path.animate?.([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
      duration: 900, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards",
    });
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
    const { items } = layoutFlowed(scene, {
      width: this.width,
      height: this.height,
      top,
      bottom: FACTS_H,
    });
    const nextPos = new Map<string, { x: number; y: number }>();

    for (const item of items) {
      if (item.kind === "bar") this.paintBar(item);
      else if (item.kind === "extent") this.paintExtent(item);
      else if (item.kind === "label") this.paintLabel(item);
      else this.paintUnits(item, nextPos);
    }

    this.lastUnitPos = nextPos;
  }

  /** 量：长度正比于数值的条。共享一把尺，差额那一截高亮——「差 24」是看出来的 */
  private paintBar(bar: PlacedBar): void {
    const tone = CHANNELS[bar.channel % CHANNELS.length]!;
    const { box } = bar;
    this.text(bar.label ?? bar.id, bar.labelAt.x, bar.labelAt.y, 12, C.ink, "start", 600);
    // 空槽：让所有条的量程一致，短的那根一眼看出"还差一截"
    this.svg.appendChild(
      el("rect", {
        x: box.x, y: box.y, width: box.w, height: box.h, rx: 6,
        fill: "none", stroke: C.rule, "stroke-width": 1,
      }),
    );
    const fill = el("rect", {
      x: box.x, y: box.y, width: Math.max(0, bar.fillW), height: box.h, rx: 6,
      fill: tone, "fill-opacity": 0.22, stroke: tone, "stroke-width": 1.5,
    });
    this.svg.appendChild(fill);
    if (!reduceMotion()) {
      fill.animate?.(
        [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
        { duration: 700, easing: "cubic-bezier(.22,1,.36,1)" },
      );
      (fill as SVGElement).style.transformOrigin = `${box.x}px ${box.y}px`;
    }
    for (const t of bar.ticks) {
      this.svg.appendChild(
        el("line", {
          x1: box.x + t, y1: box.y + 6, x2: box.x + t, y2: box.y + box.h - 6,
          stroke: tone, "stroke-width": 1, "stroke-opacity": 0.45,
        }),
      );
    }
    // 数值写在填充段内侧；条太短就挪到外面，绝不压在边框上
    const inside = bar.fillW > 46;
    this.text(
      String(bar.value),
      box.x + bar.fillW + (inside ? -10 : 8),
      box.y + box.h / 2 + 4,
      13,
      tone,
      inside ? "end" : "start",
      700,
    );
    if (bar.delta) {
      const w = bar.delta.toX - bar.delta.fromX;
      this.svg.appendChild(
        el("rect", {
          x: box.x + bar.delta.fromX, y: box.y - 4, width: w, height: box.h + 8, rx: 4,
          fill: C.beam, "fill-opacity": 0.12, stroke: C.beam,
          "stroke-width": 1.5, "stroke-dasharray": "5 3",
        }),
      );
      this.text(`差 ${bar.delta.value}`, box.x + bar.delta.fromX + w / 2, box.y - 9, 12, C.beam, "middle", 700);
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

  private paintLabel(l: PlacedLabel): void {
    this.text(
      l.placeholder ? `［${l.text}］` : l.text,
      l.at.x, l.at.y, 12, l.placeholder ? C.inkFaint : C.ink, "start", 400,
    );
  }

  /** 集：可数的记号。组身份 = 形状 × 颜色，被换过类别的记号换形状但不换位置 */
  private paintUnits(g: PlacedUnits, nextPos: Map<string, { x: number; y: number }>): void {
    const tone = CHANNELS[g.channel % CHANNELS.length]!;
    const shape = SHAPES[g.channel % SHAPES.length]!;
    const count = g.units.reduce((s, u) => s + u.weight, 0);
    const head = g.label ?? g.id;
    this.text(
      `${head}${g.note ? `（${g.note}）` : ""}`,
      g.labelAt.x, g.labelAt.y, 12, g.ghost ? C.inkFaint : C.ink, "start", 600,
    );
    if (!g.label?.includes(String(count))) {
      this.text(`${count}`, g.labelAt.x + g.box.w, g.labelAt.y, 12, C.inkFaint, "end", 600);
    }

    for (const u of g.units) {
      nextPos.set(u.id, { x: u.cx, y: u.cy });
      // 被替换过的记号长成它变成的那一类的样子（换成兔就该像兔）；
      // spec 没说变成什么时退到下一个通道，至少和原类别区分得开
      const swappedCh = u.swappedChannel ?? (g.channel + 1) % CHANNELS.length;
      const swappedTone = CHANNELS[swappedCh % CHANNELS.length]!;
      const node = this.unitNode(
        u.swapped ? SHAPES[swappedCh % SHAPES.length]! : shape,
        u.cx, u.cy, u.r,
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
              x1: u.cx + dx, y1: u.cy + u.r * 0.8,
              x2: u.cx + dx, y2: u.cy + u.r * 0.8 + u.markLen,
              stroke: u.swapped ? swappedTone : tone,
              "stroke-width": Math.max(1, u.r * 0.22),
              "stroke-linecap": "round",
            }),
          );
        }
      }
      if (u.weight > 1) {
        this.text(String(u.weight), u.cx, u.cy + u.r * 0.45, Math.max(7, u.r), "#fff", "middle", 700);
      }
      const prev = this.lastUnitPos.get(u.id);
      if (prev && !reduceMotion() && (prev.x !== u.cx || prev.y !== u.cy)) {
        node.animate?.(
          [
            { transform: `translate(${prev.x - u.cx}px, ${prev.y - u.cy}px)` },
            { transform: "translate(0,0)" },
          ],
          { duration: 700, easing: "cubic-bezier(.22,1,.36,1)" },
        );
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
    const y = this.height - FACTS_H - 14;
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
    if (marks > 0) {
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
  ): void {
    const t = el("text", {
      x, y, "font-size": size, fill, "text-anchor": anchor, "font-weight": weight,
    });
    t.textContent = content;
    this.svg.appendChild(t);
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
    // 滑杆只在有可回放过程的那一拍出现
    if (this.scrubEl) {
      this.scrubEl.style.display = this.subSteps > 0 ? "" : "none";
      this.scrubEl.max = String(Math.max(1, this.subSteps));
      this.scrubEl.value = String(this.subK);
    }
    const bar = this.controlsEl as (HTMLDivElement & { _toggle?: HTMLButtonElement; _pos?: HTMLSpanElement }) | null;
    if (!bar) return;
    if (bar._toggle) bar._toggle.textContent = this.playing ? "暂停" : "播放";
    if (bar._pos) bar._pos.textContent = `${this.index + 1} / ${this.beatCount}`;
  }
}
