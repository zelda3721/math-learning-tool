/**
 * 交互组件协议：孩子动手操作，规则由纯函数决定。
 *
 * 为什么要一套协议而不是"每个组件写一个 React 组件"：
 * - 组件的**行为**必须能被机器检查（状态怎么变、什么时候到边界），
 *   写进 React 里就只能靠点着看；抽成纯函数之后，node 里就能把十个组件全跑一遍。
 * - 渲染和规则分开：同一个 number_line_jump 可以是网页、也可以是以后的平板原生，
 *   规则只写一份。
 *
 * 这里刻意**不做判分**。探索组件回答的是"它为什么会这样"，不是"你答对了没有"；
 * 收尾的那道变式题才进证据链（见 apps/server 的 /widgets 路由）。
 */

export type WidgetKind =
  | "number_line_jump"
  | "fraction_bar"
  | "balance_scale"
  | "clock_face"
  | "area_grid"
  | "base10_blocks"
  | "pattern_train"
  | "sorting_bins"
  | "coordinate_plot"
  | "money_change";

export type WidgetControl =
  | { key: string; type: "step"; label: string; min: number; max: number; step?: number; unit?: string }
  | { key: string; type: "pick"; label: string; options: string[] }
  | { key: string; type: "toggle"; label: string };

export interface WidgetSpec {
  kind: WidgetKind;
  /** 给孩子看的标题与一句话玩法 */
  title: string;
  prompt: string;
  /** 组件自己的参数（画什么、范围多大），渲染器只读它 */
  params: Record<string, unknown>;
  controls: WidgetControl[];
  /** 想让孩子看见的那句话：不是结论考卷，是一句提示 */
  insight: string;
}

export type WidgetValue = number | string | boolean;
export type WidgetState = Record<string, WidgetValue>;

export type WidgetAction =
  | { op: "set"; key: string; value: WidgetValue }
  | { op: "add"; key: string; delta: number }
  | { op: "pick"; key: string; value: string }
  | { op: "toggle"; key: string }
  | { op: "reset" };

export interface ActionResult {
  state: WidgetState;
  /** 这次操作发生了什么（被夹到边界时说一句，而不是默默不动） */
  note?: string;
}

/** 一次探索的完整痕迹：家长/老师回看时看的是这个，不是分数 */
export interface WidgetTrace {
  widget: WidgetKind;
  actions: WidgetAction[];
  /** 最终状态：能从它重建画面 */
  finalState: WidgetState;
  endedAt: string;
}
