/**
 * 数量画面的布局解算：把「一拍里有哪些量」变成「每个记号画在哪、多大、什么颜色」。
 *
 * 纯函数、不碰 DOM——布局规则必须能单测，否则下一次改动又会把它悄悄弄坏。
 * 播放器只负责照着这里算出的坐标涂色。
 *
 * 六条通用规则（与题型无关，任何 SceneSpec 都按这套画）：
 *
 * 1. **语义标记**：不同的组要长得不一样。按组身份分配「形状 × 颜色」通道，
 *    spec 给了色名就用它，没给就按出场顺序取，跨拍稳定——同一个组永远同一副样子。
 * 2. **量画成条，集画成点**：量的意义在长短对比，摊成一堆点就读不出来了。
 *    所有条共享同一把尺（按最大值归一化），否则并排的两根条长得一样就是撒谎。
 * 3. **知觉分块**：超过 5 个就按 5 分块、块间留大缝；列数优先听 spec 的 `columns`。
 *    人要能一眼读出个数，而不是逐个去点。
 * 4. **比较要能对齐**：多根条左边缘对齐，最长的那根把超出最短的一截高亮出来并标上差值——
 *    「差 24」应该是看出来的，不是算出来的。
 * 5. **先量后分**：先算所有块的自然尺寸，超了就整体等比缩小；标签占自己的行，
 *    绝不压在内容上，也绝不画出画布。
 * 6. **画面不许自相矛盾**：内容区不侵占顶部教学句和底部事实条留出的空间。
 */
import type {
  Scene,
  UnitsShape,
  MagnitudeShape,
  ExtentShape,
  LabelShape,
  FigureShape,
} from "./scene.js";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedUnit {
  id: string;
  cx: number;
  cy: number;
  r: number;
  /** 假设法里被换过类别：形状/颜色要跟着变，但位置不动（数量不变、类别变） */
  swapped?: boolean;
  /** 换成了哪一类的通道号：长成那一类的样子，而不是随便换个颜色 */
  swappedChannel?: number;
  /** 一个记号代表 N 个真实单位（> 1 时画法要提示这是聚合） */
  weight: number;
  /**
   * 挂在这个单位下方的附属记号 x 偏移（相对 cx）。
   * 「每个个体垂下 2 根线」必须画成挂在它身上的结构——
   * 摊成独立的一堆，「每个几」就没了，而那正是乘法的意思。
   */
  markXs?: number[];
  /** 附属记号的长度 */
  markLen?: number;
  kind?: string;
}

export interface PlacedUnits {
  kind: "units";
  id: string;
  label?: string;
  note?: string;
  ghost?: boolean;
  emphasis?: boolean;
  /** 配色盘通道号（播放器映射成具体颜色/形状） */
  channel: number;
  box: Box;
  labelAt: { x: number; y: number };
  units: PlacedUnit[];
}

export interface PlacedBar {
  kind: "bar";
  id: string;
  label?: string;
  emphasis?: boolean;
  channel: number;
  /** 条的整体槽位（含未填满的部分，所以左边缘天然对齐） */
  box: Box;
  /** 实际填充宽度 = value / 全场最大值 × box.w */
  fillW: number;
  value: number;
  /** 刻度线的 x 偏移（相对 box.x），让条也能被"数" */
  ticks: number[];
  labelAt: { x: number; y: number };
  /** 这根条比最短的那根多出来的一截：差额看得见 */
  delta?: { fromX: number; toX: number; value: number };
}

export interface PlacedExtent {
  kind: "extent";
  id: string;
  label?: string;
  emphasis?: boolean;
  channel: number;
  box: Box;
  labelAt: { x: number; y: number };
}

export interface PlacedLabel {
  kind: "label";
  id: string;
  text: string;
  at: { x: number; y: number };
  placeholder?: boolean;
}

/** 讲义原图（转写重画）：布局只给框，绘制交给 figure/render 的保形投影 */
export interface PlacedFigure {
  kind: "figure";
  id: string;
  box: Box;
  shape: FigureShape;
  emphasis?: boolean;
}

export type Placed = PlacedUnits | PlacedBar | PlacedExtent | PlacedLabel | PlacedFigure;

export interface LayoutResult {
  items: Placed[];
  /** 内容实际占用的高度，播放器可据此判断是否还有空位 */
  usedHeight: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** 顶部留给教学句的高度 */
  top?: number;
  /** 底部留给计数/守恒事实条的高度 */
  bottom?: number;
}

const PAD_X = 28;
const GAP_Y = 18;
/** 标签自己的行高：内容永远从标签下方开始，两者不重叠 */
const LABEL_H = 20;
const BAR_H = 30;
const BAR_GAP = 12;
/** 知觉分块：每 5 个一小块 */
const CHUNK = 5;
const MIN_R = 2.5;
const MAX_R = 9;

/** spec 的语义色名 → 配色通道；没给色名的按出场顺序补，保证同组跨拍稳定 */
const COLOR_CHANNELS = [
  "blue",
  "yellow",
  "red",
  "green",
  "orange",
  "purple",
  "teal",
  "gold",
] as const;

export function channelOf(color: string | undefined, fallbackIndex: number): number {
  if (color) {
    const i = COLOR_CHANNELS.indexOf(color.toLowerCase() as (typeof COLOR_CHANNELS)[number]);
    if (i >= 0) return i;
  }
  return fallbackIndex % COLOR_CHANNELS.length;
}

/**
 * 每行排几列：spec 说了就听 spec 的，否则取接近正方的列数；
 * 再按可用宽度和 5 个一块的分块规则收敛。
 */
export function columnsFor(count: number, declared: number | undefined, maxColumns: number): number {
  if (count <= 0) return 1;
  const wanted =
    declared !== undefined && declared >= 1 ? declared : Math.ceil(Math.sqrt(count));
  return Math.max(1, Math.min(wanted, maxColumns, count));
}

/** 分块后的排布宽度：每满 CHUNK 列插入一道大缝 */
function chunkedX(col: number, cell: number, chunkGap: number): number {
  return col * cell + Math.floor(col / CHUNK) * chunkGap;
}

function rowWidth(columns: number, cell: number, chunkGap: number): number {
  if (columns <= 0) return 0;
  return chunkedX(columns - 1, cell, chunkGap) + cell;
}

/**
 * 解算一拍的数量画面：吃整个 Scene，输出可以直接照着画的坐标。
 *
 * 有意收整个 Scene 而不是只收 `flowed`——布局要用到 `declaredColors`
 * （"换成兔了"里的兔可能还没登场）。让调用方自己记得多传一个参数，
 * 迟早会漏。
 */
export function layoutFlowed(
  scene: Pick<Scene, "flowed" | "declaredColors">,
  opts: LayoutOptions,
): LayoutResult {
  const shapes = scene.flowed;
  const top = opts.top ?? 0;
  const bottom = opts.bottom ?? 0;
  const usableW = Math.max(40, opts.width - PAD_X * 2);
  const usableH = Math.max(60, opts.height - top - bottom);

  const bars: MagnitudeShape[] = [];
  const unitGroups: UnitsShape[] = [];
  const extents: ExtentShape[] = [];
  const labels: LabelShape[] = [];
  const figures: FigureShape[] = [];
  for (const s of shapes) {
    if (s.kind === "magnitude") bars.push(s);
    else if (s.kind === "units") unitGroups.push(s);
    else if (s.kind === "extent") extents.push(s);
    else if (s.kind === "label") labels.push(s);
    else if (s.kind === "figure") figures.push(s);
  }

  // 通道分配：spec 有色名用色名，其余按出场顺序，保证跨拍稳定
  const channels = new Map<string, number>();
  let nextChannel = 0;
  const assign = (id: string, color: string | undefined): number => {
    const existing = channels.get(id);
    if (existing !== undefined) return existing;
    const ch = channelOf(color, nextChannel);
    channels.set(id, ch);
    nextChannel += 1;
    return ch;
  };

  /**
   * 目标组的通道：优先用它自己的声明色（那才是"兔子长什么样"的依据）；
   * 目标组这一拍还没登场也照样解析得到——正因为它还没登场，
   * 被换掉的那些记号才是观众唯一能看到的"兔"。
   */
  const declaredColorById = new Map<string, string | undefined>(
    Object.entries(scene.declaredColors ?? {}),
  );
  for (const g of unitGroups) if (g.color !== undefined) declaredColorById.set(g.id, g.color);
  for (const b of bars) if (b.color !== undefined) declaredColorById.set(b.id, b.color);
  for (const e of extents) if (e.color !== undefined) declaredColorById.set(e.id, e.color);
  const channelFor = (id: string): number | undefined => {
    const known = channels.get(id);
    if (known !== undefined) return known;
    const color = declaredColorById.get(id);
    return color !== undefined ? channelOf(color, 0) : undefined;
  };

  const items: Placed[] = [];
  let cursorY = top;

  // ── 讲义原图（转写重画）：主体内容，置顶居中；其余注解排它下面 ──
  // 底图 + 各拍的图上注解（figure_overlay_*）是**同一张图**：合并后一次画出，
  // 分开排会变成上下两张对不上的图
  if (figures.length > 1) {
    const merged: FigureShape = {
      kind: "figure",
      id: figures[0]!.id,
      points: [...figures[0]!.points],
      segments: figures.flatMap((f) => f.segments),
      polygons: figures.flatMap((f) => f.polygons),
      ...(figures.some((f) => f.emphasis) ? { emphasis: true as const } : {}),
    };
    const known = new Set(merged.points.map((p) => p.id));
    for (const f of figures.slice(1))
      for (const p of f.points)
        if (!known.has(p.id)) {
          known.add(p.id);
          merged.points.push(p);
        }
    figures.length = 0;
    figures.push(merged);
  }
  if (figures.length > 0) {
    // 有别的内容要排时给图留 62% 高度，独占一拍时可以吃满
    const others = bars.length + unitGroups.length + extents.length + labels.length;
    const availH = Math.max(120, usableH * (others > 0 ? 0.62 : 0.94));
    for (const f of figures) {
      const xs = f.points.map((p) => p.at[0]);
      const ys = f.points.map((p) => p.at[1]);
      const spanW = Math.max(Math.max(...xs) - Math.min(...xs), 1e-6);
      const spanH = Math.max(Math.max(...ys) - Math.min(...ys), 1e-6);
      // 等比缩放（保形是底线），并给顶点字母留边
      const scale = Math.min((usableW - 48) / spanW, (availH - 40) / spanH);
      const w = Math.min(usableW, spanW * scale + 48);
      const h = Math.min(availH, spanH * scale + 40);
      const box: Box = { x: PAD_X + (usableW - w) / 2, y: cursorY, w, h };
      items.push({
        kind: "figure",
        id: f.id,
        box,
        shape: f,
        ...(f.emphasis ? { emphasis: true as const } : {}),
      });
      cursorY = box.y + h + GAP_Y;
    }
  }

  // ── 条：共享一把尺、左边缘对齐、差额高亮（规则 2 + 4）──
  if (bars.length > 0) {
    const maxValue = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
    const minValue = Math.min(...bars.map((b) => Math.abs(b.value)));
    const slotW = usableW;
    for (const bar of bars) {
      const value = Math.abs(bar.value);
      const fillW = (value / maxValue) * slotW;
      const box: Box = { x: PAD_X, y: cursorY + LABEL_H, w: slotW, h: BAR_H };
      // 刻度：把条切成能数的份，但不超过 20 道，免得糊成一片
      const divisions = Math.min(Math.max(Math.round(value), 1), 20);
      const ticks: number[] = [];
      for (let i = 1; i < divisions; i += 1) ticks.push((fillW * i) / divisions);
      const placed: PlacedBar = {
        kind: "bar",
        id: bar.id,
        channel: assign(bar.id, bar.color),
        box,
        fillW,
        value,
        ticks,
        labelAt: { x: PAD_X, y: cursorY + LABEL_H - 6 },
      };
      if (bar.label !== undefined) placed.label = bar.label;
      if (bar.emphasis) placed.emphasis = true;
      // 比最短那根多出来的一截 = 差额，画出来才叫"看得见"
      if (bars.length > 1 && value > minValue) {
        placed.delta = {
          fromX: (minValue / maxValue) * slotW,
          toX: fillW,
          value: value - minValue,
        };
      }
      items.push(placed);
      cursorY = box.y + BAR_H + BAR_GAP;
    }
    cursorY += GAP_Y - BAR_GAP;
  }

  // ── 几何矩形：按声明的长宽比画，横向排开 ──
  if (extents.length > 0) {
    const maxDeclaredW = Math.max(...extents.map((e) => e.w), 1);
    const totalDeclared = extents.reduce((s, e) => s + e.w, 0);
    const scale = Math.min(usableW / Math.max(totalDeclared + extents.length, 1), 60);
    let x = PAD_X;
    let rowH = 0;
    for (const e of extents) {
      const w = Math.max(24, e.w * scale);
      const h = Math.max(16, e.h * scale);
      const box: Box = { x, y: cursorY + LABEL_H, w, h };
      const placed: PlacedExtent = {
        kind: "extent",
        id: e.id,
        channel: assign(e.id, e.color),
        box,
        labelAt: { x, y: cursorY + LABEL_H - 6 },
      };
      if (e.label !== undefined) placed.label = e.label;
      if (e.emphasis) placed.emphasis = true;
      items.push(placed);
      x += w + 24;
      rowH = Math.max(rowH, h);
      void maxDeclaredW;
    }
    cursorY += LABEL_H + rowH + GAP_Y;
  }

  // ── 集：可数的记号，分块排布（规则 1 + 3）──
  if (unitGroups.length > 0) {
    // 不设下限：空间真的不够时就该缩到最小，而不是硬塞一块出去压别人。
    // 早先这里写了 Math.max(60, …)，于是内容一多，记号就画进了底部事实条里。
    const remaining = top + usableH - cursorY;
    // 先量：按自然半径算出每组要多大，超了整体缩小（规则 5）
    let r = MAX_R;
    let placedUnits: PlacedUnits[] = [];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      placedUnits = placeUnitGroups(unitGroups, {
        r,
        startY: cursorY,
        usableW,
        assign,
        channelFor,
      });
      const bottomMost = placedUnits.reduce((m, p) => Math.max(m, p.box.y + p.box.h), cursorY);
      if (bottomMost - cursorY <= remaining || r <= MIN_R) break;
      r = Math.max(MIN_R, r - 0.5);
    }
    items.push(...placedUnits);
    cursorY = placedUnits.reduce((m, p) => Math.max(m, p.box.y + p.box.h), cursorY) + GAP_Y;
  }

  // ── 纯标签：自己一行，不与任何内容抢位置 ──
  for (const l of labels) {
    const placed: PlacedLabel = { kind: "label", id: l.id, text: l.text, at: { x: PAD_X, y: cursorY + 14 } };
    if (l.placeholder) placed.placeholder = true;
    items.push(placed);
    cursorY += 24;
  }

  return { items, usedHeight: Math.max(0, cursorY - top) };
}

function placeUnitGroups(
  groups: UnitsShape[],
  ctx: {
    r: number;
    startY: number;
    usableW: number;
    assign: (id: string, color: string | undefined) => number;
    /** 目标组的通道号（换成什么就长成什么样）；目标组这一拍不在场时返回 undefined */
    channelFor: (id: string) => number | undefined;
  },
): PlacedUnits[] {
  const { r, usableW } = ctx;
  // 有附属记号时每行要多留出垂下的高度，否则腿会插进下一行
  const maxMarks = groups.reduce(
    (m, g) =>
      Math.max(m, g.perUnitMarks ?? 0, ...g.units.map((u) => u.marks ?? 0)),
    0,
  );
  const markLen = maxMarks > 0 ? Math.max(4, r * 1.1) : 0;
  const cell = r * 2 + Math.max(3, r * 0.7);
  const rowStep = cell + markLen;
  const chunkGap = Math.max(6, r * 1.2);
  const out: PlacedUnits[] = [];

  // 一行放几个组：组按自然宽度并排，放不下就换行
  let x = PAD_X;
  let y = ctx.startY;
  let rowH = 0;
  for (const g of groups) {
    const n = g.units.length;
    const maxColumns = Math.max(1, Math.floor((usableW + chunkGap) / cell));
    const columns = columnsFor(n, g.columns, maxColumns);
    const rows = Math.max(1, Math.ceil(n / columns));
    const blockW = rowWidth(columns, cell, chunkGap);
    const blockH = rows * rowStep + LABEL_H;

    if (x > PAD_X && x + blockW > PAD_X + usableW) {
      x = PAD_X;
      y += rowH + GAP_Y;
      rowH = 0;
    }

    const box: Box = { x, y, w: blockW, h: blockH };
    const units: PlacedUnit[] = g.units.map((u, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const unit: PlacedUnit = {
        id: u.id,
        cx: x + chunkedX(col, cell, chunkGap) + cell / 2,
        cy: y + LABEL_H + row * rowStep + cell / 2,
        r,
        weight: u.weight,
      };
      const marks = u.marks ?? g.perUnitMarks;
      if (marks !== undefined && marks > 0) {
        const span = r * 1.5;
        const step = marks > 1 ? span / (marks - 1) : 0;
        unit.markXs = Array.from({ length: marks }, (_, k) =>
          marks > 1 ? -span / 2 + k * step : 0,
        );
        unit.markLen = markLen;
      }
      if (u.swapped) unit.swapped = true;
      if (u.swappedTo !== undefined) {
        const ch = ctx.channelFor(u.swappedTo);
        if (ch !== undefined) unit.swappedChannel = ch;
      }
      if (u.kind !== undefined) unit.kind = u.kind;
      return unit;
    });

    const placed: PlacedUnits = {
      kind: "units",
      id: g.id,
      channel: ctx.assign(g.id, g.color),
      box,
      labelAt: { x, y: y + LABEL_H - 6 },
      units,
    };
    if (g.label !== undefined) placed.label = g.label;
    if (g.note !== undefined) placed.note = g.note;
    if (g.ghost) placed.ghost = true;
    if (g.emphasis) placed.emphasis = true;
    out.push(placed);

    x += blockW + 32;
    rowH = Math.max(rowH, blockH);
  }
  return out;
}
