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
import { solveScene, type Scene, type SceneIssue, type Shape } from "./render/scene.js";
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
    this.render();
    if (this.playing) this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
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
    const scene = solveScene(beat, this.width, this.height);

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

  /** 数量记号：10 个一行便于数；同一单位跨拍飞行（守恒可见） */
  private drawFlowed(scene: Scene): void {
    const groups = scene.flowed.filter((s): s is Extract<Shape, { kind: "units" }> => s.kind === "units");
    const labels = scene.flowed.filter((s): s is Extract<Shape, { kind: "label" }> => s.kind === "label");
    if (groups.length === 0 && labels.length === 0) return;

    const startY = scene.coords ? this.height - 120 : 40;
    const colW = Math.max(120, Math.floor((this.width - 40) / Math.max(1, groups.length)));
    const nextPos = new Map<string, { x: number; y: number }>();

    groups.forEach((g, gi) => {
      const ox = 20 + gi * colW;
      const label = el("text", { x: ox, y: startY - 10, "font-size": 11, fill: C.inkFaint });
      label.textContent = `${g.label ?? g.id}${g.note ? `（${g.note}）` : ""}`;
      this.svg.appendChild(label);

      g.units.forEach((u, i) => {
        const col = i % 10;
        const row = Math.floor(i / 10);
        const x = ox + col * 13 + 6;
        const y = startY + row * 14 + 6;
        nextPos.set(u.id, { x, y });

        const dot = el("circle", {
          cx: x, cy: y, r: 5,
          fill: g.ghost ? "none" : u.swapped ? C.beam : u.kind === "unknown" ? C.lit : C.beam,
          stroke: g.ghost ? C.inkFaint : "none",
          "stroke-dasharray": g.ghost ? "2 2" : "0",
          "fill-opacity": g.ghost ? 0 : 0.85,
        });
        this.svg.appendChild(dot);
        if (u.weight > 1) {
          const w = el("text", { x, y: y + 3, "text-anchor": "middle", "font-size": 8, fill: "#fff" });
          w.textContent = String(u.weight);
          this.svg.appendChild(w);
        }

        // FLIP：同一个单位从上一拍的位置飞到这一拍的位置
        const prev = this.lastUnitPos.get(u.id);
        if (prev && !reduceMotion() && (prev.x !== x || prev.y !== y)) {
          dot.animate?.(
            [{ transform: `translate(${prev.x - x}px, ${prev.y - y}px)` }, { transform: "translate(0,0)" }],
            { duration: 700, easing: "cubic-bezier(.22,1,.36,1)" },
          );
        }
      });
    });

    labels.forEach((l, i) => {
      const t = el("text", {
        x: 20, y: startY + 60 + i * 18, "font-size": 12,
        fill: l.placeholder ? C.inkFaint : C.ink,
      });
      t.textContent = l.placeholder ? `［${l.text}］` : l.text;
      this.svg.appendChild(t);
    });

    this.lastUnitPos = nextPos;
  }

  /** 计数事实与守恒：一致就安静，不一致必须显眼——这正是验算的价值 */
  private drawFacts(scene: Scene): void {
    let y = 18;
    for (const c of scene.counts) {
      const ok = c.claimed === c.actual;
      const t = el("text", {
        x: this.width - 12, y, "text-anchor": "end", "font-size": 12,
        fill: ok ? C.correct : C.wrong, "font-family": "ui-monospace,monospace",
      });
      t.textContent = ok ? `数一遍：${c.actual} ✓` : `说是 ${c.claimed}，数出来 ${c.actual} ✗`;
      this.svg.appendChild(t);
      y += 16;
    }
    if (scene.conservation) {
      const { before, after, ok } = scene.conservation;
      const t = el("text", {
        x: this.width - 12, y, "text-anchor": "end", "font-size": 12,
        fill: ok ? C.correct : C.wrong, "font-family": "ui-monospace,monospace",
      });
      t.textContent = ok ? `总数没变：${before} → ${after} ✓` : `总数对不上：${before} → ${after} ✗`;
      this.svg.appendChild(t);
      y += 16;
    }
    if (scene.equality) {
      const { left, right, ok } = scene.equality;
      const t = el("text", {
        x: this.width - 12, y, "text-anchor": "end", "font-size": 12,
        fill: ok ? C.correct : C.wrong, "font-family": "ui-monospace,monospace",
      });
      t.textContent = `${left} ${ok ? "=" : "≠"} ${right}`;
      this.svg.appendChild(t);
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
    bar.append(prev, toggle, next, pos);
    this.controlsEl = bar;
    (bar as HTMLDivElement & { _toggle?: HTMLButtonElement })._toggle = toggle;
    (bar as HTMLDivElement & { _pos?: HTMLSpanElement })._pos = pos;
    return bar;
  }

  private syncControls(): void {
    const bar = this.controlsEl as (HTMLDivElement & { _toggle?: HTMLButtonElement; _pos?: HTMLSpanElement }) | null;
    if (!bar) return;
    if (bar._toggle) bar._toggle.textContent = this.playing ? "暂停" : "播放";
    if (bar._pos) bar._pos.textContent = `${this.index + 1} / ${this.beatCount}`;
  }
}
