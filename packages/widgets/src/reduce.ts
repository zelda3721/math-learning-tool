import { widgetOf } from "./catalog.js";
import type { ActionResult, WidgetAction, WidgetSpec, WidgetState, WidgetValue } from "./types.js";

/**
 * 组件状态机：纯函数，两种输入（当前状态、一次操作），一种输出（新状态 + 一句说明）。
 *
 * 为什么边界要"夹住并说明"而不是"照单全收"：
 * 孩子把分母拖到 15 时，分数条的份数不会真的变成 15（那已经看不清了）——
 * 这时把一个数字悄悄改掉，他会以为自己拖错了。夹住并回一句"最多 12 份"，
 * 他就知道边界在哪儿。这条规矩是 `/reduce.ts` 存在的理由之一。
 */

/** 每个组件的初始状态：从上界与常见值出发，别让孩子面对一个空画布 */
export function initialWidgetState(spec: WidgetSpec): WidgetState {
  switch (spec.kind) {
    case "number_line_jump":
      return { start: 3, jump: 4, direction: "向右（加）" };
    case "fraction_bar":
      return { denominator: 4, numerator: 1 };
    case "balance_scale":
      return { left: 5, right: 3 };
    case "clock_face":
      return { hour: 8, minute: 0 };
    case "area_grid":
      return { width: 4, height: 3 };
    case "base10_blocks":
      return { ones: 6, tens: 1 };
    case "pattern_train":
      return { mode: true };
    case "sorting_bins":
      return { bin: "筐 A", count: 0 };
    case "coordinate_plot":
      return { x: 3, y: 2 };
    case "money_change":
      return { price: 8, paid: 10 };
  }
}

function controlOf(spec: WidgetSpec, key: string) {
  return spec.controls.find((c) => c.key === key);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 跨字段的约束，各家不同：
 * - 分数条的分子不能超过分母（涂了 5 份而只分成 4 份，画不出来）；
 * - 十进制的散块超过 10 就该捆成条（这正是要让孩子看见的事，所以允许到 30，超了夹）；
 * - 找零的付钱少于价格时"没得找"，状态照旧，由 summarize 说出来。
 */
function reconcile(spec: WidgetSpec, state: WidgetState): { state: WidgetState; note?: string } {
  if (spec.kind === "fraction_bar") {
    const denominator = Number(state.denominator ?? 4);
    const numerator = Number(state.numerator ?? 0);
    if (numerator > denominator) {
      return {
        state: { ...state, numerator: denominator },
        note: `只分成 ${denominator} 份，最多涂 ${denominator} 份`,
      };
    }
  }
  if (spec.kind === "base10_blocks") {
    const ones = Number(state.ones ?? 0);
    if (ones > 30) return { state: { ...state, ones: 30 }, note: "散块最多 30 个，再多就该捆了" };
  }
  return { state };
}

/** 状态 → 一句人话（家长回看、儿童提示都读它） */
export function summarizeWidget(spec: WidgetSpec, state: WidgetState): string {
  switch (spec.kind) {
    case "number_line_jump": {
      const start = Number(state.start ?? 0);
      const jump = Number(state.jump ?? 0);
      const right = String(state.direction ?? "").includes("右");
      const end = right ? start + jump : start - jump;
      return `从 ${start} 出发，往${right ? "右" : "左"}跳 ${jump} 格，落在 ${end}`;
    }
    case "fraction_bar": {
      const d = Number(state.denominator ?? 1);
      const n = Number(state.numerator ?? 0);
      const percent = d > 0 ? Math.round((n / d) * 100) : 0;
      return `分成 ${d} 份、涂了 ${n} 份，也就是 ${n}/${d}（约 ${percent}%）`;
    }
    case "balance_scale": {
      const l = Number(state.left ?? 0);
      const r = Number(state.right ?? 0);
      if (l === r) return `两边都是 ${l}，天平是平的`;
      return `${l > r ? "左边" : "右边"}重 ${Math.abs(l - r)}，天平歪向${l > r ? "左" : "右"}`;
    }
    case "clock_face": {
      const h = Number(state.hour ?? 0);
      const m = Number(state.minute ?? 0);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    case "area_grid": {
      const w = Number(state.width ?? 0);
      const h = Number(state.height ?? 0);
      return `长 ${w}、宽 ${h}，一共要 ${w * h} 个小方格`;
    }
    case "base10_blocks": {
      const ones = Number(state.ones ?? 0);
      const tens = Number(state.tens ?? 0);
      return `${tens} 条十 + ${ones} 个一 = ${tens * 10 + ones}`;
    }
    case "pattern_train":
      return state.mode ? "红蓝红蓝地交替下去" : "同一种颜色连下去";
    case "sorting_bins":
      return `${String(state.bin ?? "筐 A")} 里放了 ${Number(state.count ?? 0)} 个`;
    case "coordinate_plot": {
      const x = Number(state.x ?? 0);
      const y = Number(state.y ?? 0);
      return `往右 ${x} 格、往上 ${y} 格，就是点 (${x}, ${y})`;
    }
    case "money_change": {
      const price = Number(state.price ?? 0);
      const paid = Number(state.paid ?? 0);
      if (paid < price) return `付了 ${paid}，比价格 ${price} 还少 ${price - paid}，不够`;
      return `价格 ${price}、付了 ${paid}，应找 ${paid - price}`;
    }
  }
}

/** 改一个值：先按控件范围夹住，再走跨字段约束 */
export function applyWidgetAction(spec: WidgetSpec, state: WidgetState, action: WidgetAction): ActionResult {
  if (action.op === "reset") return { state: initialWidgetState(spec) };

  const key = action.op === "pick" || action.op === "toggle" ? action.key : action.key;
  const control = controlOf(spec, key);
  if (!control) return { state, note: `没有「${key}」这个可动的东西` };

  let next: WidgetState = { ...state };
  let note: string | undefined;

  if (action.op === "set") {
    next[key] = action.value;
  } else if (action.op === "add") {
    next[key] = Number(state[key] ?? 0) + action.delta;
  } else if (action.op === "pick") {
    if (control.type !== "pick") return { state, note: `「${control.label}」不是选择题` };
    if (!control.options.includes(action.value)) {
      return { state, note: `「${control.label}」只有这些选项：${control.options.join("、")}` };
    }
    next[key] = action.value;
  } else if (action.op === "toggle") {
    if (control.type !== "toggle") return { state, note: `「${control.label}」不是开关` };
    next[key] = !(state[key] ?? false);
  }

  if (control.type === "step") {
    const raw = Number(next[key]);
    if (!Number.isFinite(raw)) {
      next[key] = Number(state[key] ?? control.min);
      note = `「${control.label}」要填数字`;
    } else {
      const value = clamp(raw, control.min, control.max);
      if (value !== raw) note = `「${control.label}」最多 ${control.max}、最少 ${control.min}`;
      next[key] = value;
    }
  }

  const reconciled = reconcile(spec, next);
  return { state: reconciled.state, ...(reconciled.note ?? note ? { note: reconciled.note ?? note } : {}) };
}

/** 从操作记录重放：同一串操作必须得到同一个状态（回看与调试靠这条） */
export function replayWidget(kind: string, actions: WidgetAction[]): WidgetState | null {
  const spec = widgetOf(kind);
  if (!spec) return null;
  let state = initialWidgetState(spec);
  for (const action of actions) state = applyWidgetAction(spec, state, action).state;
  return state;
}

/** 控件可选值：给渲染器出滑杆/按钮用，避免前端自己算边界 */
export function controlBounds(spec: WidgetSpec, key: string): { min?: number; max?: number; step?: number } {
  const control = controlOf(spec, key);
  return control && control.type === "step" ? { min: control.min, max: control.max, step: control.step } : {};
}

/** 这个状态算不算"已经摸到过"（至少动过一次）：用于决定要不要提示收尾 */
export function hasExplored(state: WidgetState, initial: WidgetState): boolean {
  return Object.keys(initial).some((k) => state[k] !== initial[k]) || Object.keys(state).some((k) => state[k] !== initial[k]);
}

export function isWidgetValue(v: unknown): v is WidgetValue {
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}
