import type { SceneSpec } from "@mathtutor/schema";
import { foldBeats, type BeatState, type RenderObject } from "./fold.js";
import { num } from "./refs.js";

/**
 * 模式 A 播放器：零依赖原生 DOM/SVG 受控组件（仿 apps/web/src/atlas/treeCanvas.ts）。
 * 每拍从 foldBeats 的 BeatState 全量重绘一层 SVG，拍间用 WAAPI 做淡入/移动过渡；
 * prefers-reduced-motion 时跳过动画。自带极简控制条（opts.controls=false 可关）。
 */

export interface ExplainerPlayerOptions {
  autoPlay?: boolean;
  beatMs?: number;
  onBeatChange?: (i: number, total: number) => void;
  /** 关掉自带控制条（调用方自己渲染控制 UI 时用）；默认开 */
  controls?: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const CELL = 20; // 计数网格单元边长
const GRID_COLS = 10; // 计数网格每行最多单元数
const GAP_X = 32; // 对象间横向间距
const GAP_Y = 30; // 换行纵向间距
const ROW_MAX_W = 700; // 超过则换行
const PAD = 18; // viewBox 内边距

const COLOR = {
  ink: "#334155",
  unit: "#3b82f6",
  unitEdge: "#1d4ed8",
  removed: "#94a3b8",
  label: "#0f172a",
  meaning: "#64748b",
  emphasis: "#f59e0b",
  caption: "#1e293b",
};

interface Placed {
  obj: RenderObject;
  x: number;
  y: number;
  w: number;
  h: number;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function text(content: string, x: number, y: number, size: number, fill: string, anchor = "middle") {
  const t = svgEl("text", {
    x,
    y,
    "font-size": size,
    fill,
    "text-anchor": anchor,
    "font-family": "system-ui, sans-serif",
  });
  t.textContent = content;
  return t;
}

function reducedMotion(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 计数类图元：quantity_bar / unit_grid / 带 count 的 dot、circle 都画成单元网格 */
function isCountable(obj: RenderObject): boolean {
  if (obj.primitive === "quantity_bar" || obj.primitive === "unit_grid") return true;
  return (obj.primitive === "dot" || obj.primitive === "circle") && (obj.count ?? 0) > 1;
}

/** 估算图元几何尺寸（不含 label/meaning 文本） */
function glyphSize(obj: RenderObject): { w: number; h: number } {
  const p = obj.params;
  if (isCountable(obj)) {
    const count = Math.max(1, obj.count ?? 1);
    const cols = Math.min(count, GRID_COLS);
    const rows = Math.ceil(count / GRID_COLS);
    return { w: cols * CELL, h: rows * CELL };
  }
  switch (obj.primitive) {
    case "dot":
      return { w: 16, h: 16 };
    case "circle": {
      const r = Math.min(60, Math.max(10, num(p.radius, 24)));
      return { w: r * 2, h: r * 2 };
    }
    case "rectangle":
      return {
        w: Math.min(180, Math.max(24, num(p.width, 80))),
        h: Math.min(120, Math.max(18, num(p.height, 50))),
      };
    case "line":
      return { w: Math.min(220, Math.max(40, num(p.length, 100))), h: 10 };
    case "arrow":
      return { w: Math.min(220, Math.max(40, num(p.length, 100))), h: 14 };
    case "number_line":
      return { w: 230, h: 34 };
    case "axes":
      return { w: 120, h: 110 };
    case "function_curve":
      return { w: 140, h: 100 };
    case "polygon":
      return { w: 90, h: 76 };
    case "balance":
      return { w: 150, h: 84 };
    case "relation_node":
    default: {
      const t = obj.label ?? obj.id;
      return { w: Math.max(64, t.length * 13 + 24), h: 36 };
    }
  }
}

/** 把一个对象画进 <g>（原点在图元左上角），返回图元尺寸 */
function drawGlyph(g: SVGGElement, obj: RenderObject): { w: number; h: number } {
  const size = glyphSize(obj);
  const p = obj.params;

  if (isCountable(obj)) {
    const count = Math.max(1, obj.count ?? 1);
    const removed = Math.min(count, obj.removedCount ?? 0);
    const asBar = obj.primitive === "quantity_bar" || obj.primitive === "unit_grid";
    for (let i = 0; i < count; i++) {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const cx = col * CELL + CELL / 2;
      const cy = row * CELL + CELL / 2;
      // 约定：拿走的是「最后 removed 个」单元
      const isRemoved = i >= count - removed;
      const fill = isRemoved ? "none" : COLOR.unit;
      const stroke = isRemoved ? COLOR.removed : COLOR.unitEdge;
      if (asBar) {
        g.appendChild(
          svgEl("rect", {
            x: col * CELL + 1,
            y: row * CELL + 1,
            width: CELL - 2,
            height: CELL - 2,
            rx: 3,
            fill,
            stroke,
            "stroke-width": 1.5,
            opacity: isRemoved ? 0.55 : 1,
          }),
        );
      } else {
        g.appendChild(
          svgEl("circle", {
            cx,
            cy,
            r: CELL / 2 - 3,
            fill,
            stroke,
            "stroke-width": 1.5,
            opacity: isRemoved ? 0.55 : 1,
          }),
        );
      }
      if (isRemoved) {
        // 划掉：单元格对角线
        g.appendChild(
          svgEl("line", {
            x1: col * CELL + 3,
            y1: row * CELL + 3,
            x2: (col + 1) * CELL - 3,
            y2: (row + 1) * CELL - 3,
            stroke: COLOR.removed,
            "stroke-width": 2,
            "stroke-linecap": "round",
          }),
        );
      }
    }
    return size;
  }

  switch (obj.primitive) {
    case "dot":
      g.appendChild(svgEl("circle", { cx: 8, cy: 8, r: 6, fill: COLOR.unit }));
      break;
    case "circle":
      g.appendChild(
        svgEl("circle", {
          cx: size.w / 2,
          cy: size.h / 2,
          r: size.w / 2 - 1.5,
          fill: "none",
          stroke: COLOR.ink,
          "stroke-width": 2,
        }),
      );
      break;
    case "rectangle":
      g.appendChild(
        svgEl("rect", {
          x: 1,
          y: 1,
          width: size.w - 2,
          height: size.h - 2,
          rx: 4,
          fill: "none",
          stroke: COLOR.ink,
          "stroke-width": 2,
        }),
      );
      break;
    case "line":
      g.appendChild(
        svgEl("line", {
          x1: 0,
          y1: size.h / 2,
          x2: size.w,
          y2: size.h / 2,
          stroke: COLOR.ink,
          "stroke-width": 2.5,
          "stroke-linecap": "round",
        }),
      );
      break;
    case "arrow": {
      const y = size.h / 2;
      g.appendChild(
        svgEl("line", {
          x1: 0,
          y1: y,
          x2: size.w - 10,
          y2: y,
          stroke: COLOR.ink,
          "stroke-width": 2.5,
          "stroke-linecap": "round",
        }),
      );
      g.appendChild(
        svgEl("polygon", {
          points: `${size.w},${y} ${size.w - 10},${y - 5} ${size.w - 10},${y + 5}`,
          fill: COLOR.ink,
        }),
      );
      break;
    }
    case "number_line": {
      const min = num(p.min, 0);
      const max0 = num(p.max, 10);
      const max = max0 > min ? max0 : min + 10;
      const step = Math.max(num(p.step, 1), (max - min) / 20); // 最多约 20 个刻度
      const y = 14;
      g.appendChild(
        svgEl("line", { x1: 0, y1: y, x2: size.w, y2: y, stroke: COLOR.ink, "stroke-width": 2 }),
      );
      for (let v = min; v <= max + 1e-9; v += step) {
        const x = ((v - min) / (max - min)) * (size.w - 16) + 8;
        g.appendChild(
          svgEl("line", { x1: x, y1: y - 5, x2: x, y2: y + 5, stroke: COLOR.ink, "stroke-width": 1.5 }),
        );
        g.appendChild(text(String(Math.round(v * 100) / 100), x, y + 18, 10, COLOR.meaning));
      }
      break;
    }
    case "axes": {
      const ox = 14;
      const oy = size.h - 14;
      g.appendChild(
        svgEl("line", { x1: ox, y1: oy, x2: size.w, y2: oy, stroke: COLOR.ink, "stroke-width": 2 }),
      );
      g.appendChild(
        svgEl("polygon", {
          points: `${size.w},${oy} ${size.w - 8},${oy - 4} ${size.w - 8},${oy + 4}`,
          fill: COLOR.ink,
        }),
      );
      g.appendChild(svgEl("line", { x1: ox, y1: oy, x2: ox, y2: 0, stroke: COLOR.ink, "stroke-width": 2 }));
      g.appendChild(
        svgEl("polygon", { points: `${ox},0 ${ox - 4},8 ${ox + 4},8`, fill: COLOR.ink }),
      );
      break;
    }
    case "function_curve": {
      const pts = Array.isArray(p.points) ? (p.points as unknown[]) : null;
      let d: string;
      if (pts && pts.length >= 2) {
        const nums = pts
          .map((pt) => (Array.isArray(pt) ? [num(pt[0], 0), num(pt[1], 0)] : null))
          .filter((pt): pt is [number, number] => pt !== null);
        if (nums.length >= 2) {
          const xs = nums.map((n) => n[0]);
          const ys = nums.map((n) => n[1]);
          const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
          const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
          const sx = (x: number) => ((x - minX) / (maxX - minX || 1)) * size.w;
          const sy = (y: number) => size.h - ((y - minY) / (maxY - minY || 1)) * size.h;
          d = nums.map((n, i) => `${i === 0 ? "M" : "L"}${sx(n[0])},${sy(n[1])}`).join(" ");
        } else {
          d = `M0,${size.h} Q${size.w / 2},${-size.h * 0.4} ${size.w},${size.h}`;
        }
      } else {
        d = `M0,${size.h} Q${size.w / 2},${-size.h * 0.4} ${size.w},${size.h}`;
      }
      g.appendChild(svgEl("path", { d, fill: "none", stroke: COLOR.unit, "stroke-width": 2.5 }));
      break;
    }
    case "polygon": {
      const raw = Array.isArray(p.points) ? (p.points as unknown[]) : null;
      const pts =
        raw
          ?.map((pt) => (Array.isArray(pt) ? `${num(pt[0], 0)},${num(pt[1], 0)}` : null))
          .filter((s): s is string => s !== null) ?? [];
      const points = pts.length >= 3 ? pts.join(" ") : `${size.w / 2},2 2,${size.h - 2} ${size.w - 2},${size.h - 2}`;
      g.appendChild(
        svgEl("polygon", { points, fill: "none", stroke: COLOR.ink, "stroke-width": 2 }),
      );
      break;
    }
    case "balance": {
      // 简形天平：支点三角 + 横梁 + 两侧吊盘
      const cx = size.w / 2;
      const beamY = 22;
      g.appendChild(
        svgEl("polygon", {
          points: `${cx},${beamY} ${cx - 12},${size.h - 8} ${cx + 12},${size.h - 8}`,
          fill: "none",
          stroke: COLOR.ink,
          "stroke-width": 2,
        }),
      );
      g.appendChild(
        svgEl("line", { x1: 8, y1: beamY, x2: size.w - 8, y2: beamY, stroke: COLOR.ink, "stroke-width": 2.5 }),
      );
      for (const px of [16, size.w - 16]) {
        g.appendChild(
          svgEl("line", { x1: px, y1: beamY, x2: px, y2: beamY + 16, stroke: COLOR.ink, "stroke-width": 1.5 }),
        );
        g.appendChild(
          svgEl("path", {
            d: `M${px - 14},${beamY + 16} A14,10 0 0 0 ${px + 14},${beamY + 16}`,
            fill: "none",
            stroke: COLOR.ink,
            "stroke-width": 2,
          }),
        );
      }
      break;
    }
    case "relation_node":
    default: {
      // 标签盒（relation_node 与未知图元兜底）
      g.appendChild(
        svgEl("rect", {
          x: 1,
          y: 1,
          width: size.w - 2,
          height: size.h - 2,
          rx: 8,
          fill: "#f1f5f9",
          stroke: COLOR.ink,
          "stroke-width": 1.5,
        }),
      );
      g.appendChild(
        text(obj.label ?? obj.primitive, size.w / 2, size.h / 2 + 4.5, 13, COLOR.label),
      );
      break;
    }
  }
  return size;
}

/** 横排布局，超宽换行；返回摆放结果与内容总尺寸 */
function layout(objects: RenderObject[]): { placed: Placed[]; w: number; h: number } {
  const placed: Placed[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let maxW = 0;
  for (const obj of objects) {
    const glyph = glyphSize(obj);
    const labelW = obj.label ? obj.label.length * 13 : 0;
    const meaningW = obj.meaning ? obj.meaning.length * 11 : 0;
    const w = Math.max(glyph.w, labelW, meaningW, 24);
    const h = glyph.h + (obj.label ? 20 : 0) + (obj.meaning ? 17 : 0);
    if (x > 0 && x + w > ROW_MAX_W) {
      x = 0;
      y += rowH + GAP_Y;
      rowH = 0;
    }
    placed.push({ obj, x, y, w, h });
    x += w + GAP_X;
    rowH = Math.max(rowH, h);
    maxW = Math.max(maxW, x - GAP_X);
  }
  return { placed, w: Math.max(maxW, 1), h: Math.max(y + rowH, 1) };
}

export class ExplainerPlayer {
  readonly beatCount: number;

  private beats: BeatState[];
  private opts: ExplainerPlayerOptions;
  private index = 0;
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private root!: HTMLElement;
  private svg!: SVGSVGElement;
  private caption!: HTMLElement;
  private playBtn: HTMLButtonElement | null = null;
  private dots: HTMLElement[] = [];
  private container: HTMLElement;

  /** 上一拍各对象的摆放位置，用于移动过渡 */
  private prevPos = new Map<string, { x: number; y: number }>();

  constructor(container: HTMLElement, spec: SceneSpec, opts: ExplainerPlayerOptions = {}) {
    this.container = container;
    this.opts = opts;
    this.beats = foldBeats(spec);
    this.beatCount = this.beats.length;
    this.build();
    this.renderBeat(false);
    if (opts.autoPlay && this.beatCount > 1) this.play();
  }

  play(): void {
    if (this.destroyed || this.playing || this.beatCount <= 1) return;
    this.playing = true;
    this.updatePlayBtn();
    this.schedule();
  }

  pause(): void {
    this.playing = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.updatePlayBtn();
  }

  next(): void {
    this.goTo(this.index + 1);
  }

  prev(): void {
    this.goTo(this.index - 1);
  }

  goTo(i: number): void {
    if (this.destroyed || this.beatCount === 0) return;
    const clamped = Math.max(0, Math.min(this.beatCount - 1, i));
    if (clamped === this.index && i !== this.index) return;
    this.index = clamped;
    this.renderBeat(true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pause();
    this.root.remove();
  }

  // ---- 内部 ----

  private schedule(): void {
    if (!this.playing) return;
    this.timer = setTimeout(() => {
      if (!this.playing || this.destroyed) return;
      if (this.index >= this.beatCount - 1) {
        this.pause();
        return;
      }
      this.index += 1;
      this.renderBeat(true);
      this.schedule();
    }, this.opts.beatMs ?? 2600);
  }

  private build(): void {
    this.root = document.createElement("div");
    this.root.style.cssText =
      "display:flex;flex-direction:column;gap:8px;width:100%;font-family:system-ui,sans-serif;";

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.style.cssText = "display:block;width:100%;background:#ffffff;border-radius:8px;";
    this.root.appendChild(this.svg);

    this.caption = document.createElement("div");
    this.caption.style.cssText =
      `min-height:1.5em;padding:4px 8px;font-size:15px;line-height:1.5;color:${COLOR.caption};text-align:center;`;
    this.root.appendChild(this.caption);

    if (this.opts.controls !== false) this.buildControls();
    this.container.appendChild(this.root);
  }

  private buildControls(): void {
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;justify-content:center;gap:10px;";

    const mkBtn = (label: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText =
        "border:1px solid #cbd5e1;background:#f8fafc;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:14px;";
      b.addEventListener("click", onClick);
      bar.appendChild(b);
      return b;
    };

    mkBtn("‹", () => {
      this.pause();
      this.prev();
    });
    this.playBtn = mkBtn("▶", () => (this.playing ? this.pause() : this.play()));
    mkBtn("›", () => {
      this.pause();
      this.next();
    });

    const dotsWrap = document.createElement("div");
    dotsWrap.style.cssText = "display:flex;gap:6px;margin-left:8px;";
    for (let i = 0; i < this.beatCount; i++) {
      const dot = document.createElement("span");
      dot.style.cssText =
        "width:8px;height:8px;border-radius:50%;background:#cbd5e1;cursor:pointer;display:inline-block;";
      dot.addEventListener("click", () => {
        this.pause();
        this.goTo(i);
      });
      dotsWrap.appendChild(dot);
      this.dots.push(dot);
    }
    bar.appendChild(dotsWrap);
    this.root.appendChild(bar);
  }

  private updatePlayBtn(): void {
    if (this.playBtn) this.playBtn.textContent = this.playing ? "⏸" : "▶";
  }

  private renderBeat(animate: boolean): void {
    const beat = this.beats[this.index];
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

    if (!beat) {
      this.caption.textContent = "（无可视内容）";
      return;
    }

    const { placed, w, h } = layout(beat.objects);
    this.svg.setAttribute("viewBox", `0 0 ${w + PAD * 2} ${h + PAD * 2}`);

    const doAnimate = animate && !reducedMotion();
    const nextPos = new Map<string, { x: number; y: number }>();

    for (const item of placed) {
      const { obj } = item;
      const gx = item.x + PAD;
      const gy = item.y + PAD;
      const g = svgEl("g", { transform: `translate(${gx},${gy})` });

      if (obj.emphasis) {
        g.appendChild(
          svgEl("rect", {
            x: -6,
            y: -6,
            width: item.w + 12,
            height: item.h + 12,
            rx: 8,
            fill: "none",
            stroke: COLOR.emphasis,
            "stroke-width": 2,
            "stroke-dasharray": "5 4",
          }),
        );
      }

      const glyphW = glyphSize(obj).w;
      const glyphG = svgEl("g", { transform: `translate(${(item.w - glyphW) / 2},0)` });
      const glyph = drawGlyph(glyphG, obj);
      g.appendChild(glyphG);

      let ty = glyph.h + 15;
      // relation_node/未知兜底盒已把 label 画在盒内，避免重复
      const labelInBox = obj.primitive === "relation_node" || !glyphIsKnown(obj.primitive);
      if (obj.label && !labelInBox) {
        g.appendChild(text(obj.label, item.w / 2, ty, 13, COLOR.label));
        ty += 17;
      } else if (obj.label && labelInBox) {
        ty += 2;
      }
      if (obj.meaning) {
        g.appendChild(text(obj.meaning, item.w / 2, ty, 11, COLOR.meaning));
      }

      this.svg.appendChild(g);
      nextPos.set(obj.id, { x: gx, y: gy });

      if (doAnimate && typeof g.animate === "function") {
        const prev = this.prevPos.get(obj.id);
        if (!prev) {
          g.animate(
            [
              { opacity: 0, transform: `translate(${gx}px, ${gy + 8}px)` },
              { opacity: 1, transform: `translate(${gx}px, ${gy}px)` },
            ],
            { duration: 260, easing: "ease-out" },
          );
        } else if (prev.x !== gx || prev.y !== gy) {
          g.animate(
            [
              { transform: `translate(${prev.x}px, ${prev.y}px)` },
              { transform: `translate(${gx}px, ${gy}px)` },
            ],
            { duration: 320, easing: "ease-in-out" },
          );
        } else if (obj.emphasis) {
          g.animate([{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }], { duration: 420 });
        }
      }
    }

    this.prevPos = nextPos;
    this.caption.textContent = beat.teachingLine ?? "";

    this.dots.forEach((dot, i) => {
      dot.style.background = i === this.index ? COLOR.emphasis : "#cbd5e1";
    });

    this.opts.onBeatChange?.(this.index, this.beatCount);
  }
}

function glyphIsKnown(primitive: string): boolean {
  return [
    "dot",
    "circle",
    "rectangle",
    "line",
    "function_curve",
    "arrow",
    "quantity_bar",
    "unit_grid",
    "number_line",
    "axes",
    "polygon",
    "balance",
  ].includes(primitive);
}
