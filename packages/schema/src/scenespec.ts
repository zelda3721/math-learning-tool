import { z } from "zod";

/**
 * SceneSpec（Visual IR，设计 §05 讲解双模式）：引擎 Solve→Verify→Direct 的产物，
 * 是「讲解数据」的一等契约——Web 播放器（模式 A）与 Manim 编译器（模式 B）共同消费。
 * 结构刻意宽容（passthrough）：引擎的确定性 lowering 会携带丰富的内部字段，
 * 这里只锁定播放器渲染所依赖的骨架。
 */

/**
 * 视觉词汇表（primitive → params 约定）
 *
 * schema 本身是 passthrough，不锁死 params 结构；这段注释是引擎与播放器之间
 * 的词汇契约。**数学事实一律由 params 里的表达式/坐标决定，播放器必须自己算，
 * 算不出来就诚实地显示「这条曲线没能算出来」，绝不画装饰性图形。**
 *
 * 共同约定：
 * - 所有坐标都是**数据坐标**（同一场景共享一个数据坐标空间，由 `axes` /
 *   `number_line` 的 range 界定），不是像素；缩放必须全场景统一，不可各画各的。
 * - 表达式是 SymPy 风味字符串，可能出现 `**` 或 `^`（等价）、`sin/cos/tan/exp/
 *   log/sqrt/Abs/pi/E`；变量名由同一 params 的 `variable` 给出。
 *
 * 通用构件：
 * - `axes`        params: `{ x_range: [number, number], y_range: [number, number] }`
 * - `number_line` params: `{ x_range: [number, number] }`
 * - `function_curve` params: `{ expression: string, variable: string,
 *                              x_range: [number, number] }`
 *                   —— **是表达式，不是采样点**；播放器自行采样。引擎的 Manim
 *                   通道会额外塞入 `sampled_segments`（已采样折线段），有则可直接用。
 * - `dot`         params: `{ x, y, open? }` 或 `{ positions: [[x, y], ...] }`
 * - `line`        params: `{ start: [x, y], end: [x, y] }`（也可能带 `points`）
 * - `arrow`       params: `{ start: [x, y], end: [x, y] }`
 * - `polygon`     params: `{ vertices: [[x, y], ...] }`
 * - `rectangle` / `circle` / `unit_grid` / `quantity_bar` / `relation_node` /
 *   `balance`：数量与关系类构件，`params.count` 表示单位个数，数量动词
 *   （combine / partition / replicate / count / recount_verify）作用于它们。
 *
 * 微积分构件（引擎 build_derivative/integral/limit/composition_visual_plan 产出，
 * 全部参数由已验证的 Math IR 证据重算得到，播放器可独立复算校验）：
 * - `tangent_line`：某点处的切线。
 *   params: `{ expression, variable, at_x: number, slope: number,
 *              derivative?: string, start: [x, y], end: [x, y] }`
 *   斜率来自确定性求导；`start/end` 是已算好的数据坐标端点。
 * - `secant_line`：割线，逐拍 h 递减 → 趋近切线。
 *   params: `{ expression, variable, x0: number, h: number, slope: number,
 *              start: [x, y], end: [x, y] }`
 *   `slope` 恒等于 (f(x0+h) − f(x0)) / h，播放器可自行校验。
 * - `riemann_rects`：定积分的累积矩形，n 逐拍递增（4 → 8 → 16）。
 *   params: `{ expression, variable, x_range: [a, b], n: number,
 *              side: 'left' | 'right' | 'mid', approx_area: number,
 *              rects: [[left, right, height], ...] }`
 *   `rects` 已按真实函数值算好；`approx_area` 是它们的面积和。
 * - `limit_approach`：自变量两侧逼近时函数值的走向。
 *   params: `{ expression, variable, target: number,
 *              from: 'left' | 'right' | 'both', offsets: number[],
 *              points: { left?: [x, y][], right?: [x, y][] },
 *              limit_value?: number, divergent?: boolean }`
 *   `divergent: true` 表示确定性计算判定发散——此时不得画任何「极限高度线」。
 * - `composition_chain`：复合函数 x →(内层)→ u →(外层)→ y 的映射链。
 *   params: `{ outer: string（以 u 为自变量）, inner: string（以 variable 为自变量）,
 *              variable: string, x_range: [number, number],
 *              u_range: [number, number],
 *              samples: [{ x: number, u: number, y: number }, ...] }`
 *   引擎已校验 outer(inner(x)) 与合成表达式在每个 sample 上一致。
 */
export const VisualObjectSchema = z
  .object({
    id: z.string(),
    primitive: z.string(),
    params: z.record(z.unknown()).default({}),
    label: z.string().optional(),
    meaning: z.string().optional(),
  })
  .passthrough();
export type VisualObject = z.infer<typeof VisualObjectSchema>;

export const SceneActionSchema = z
  .object({
    op: z.string(),
  })
  .passthrough();
export type SceneAction = z.infer<typeof SceneActionSchema>;

export const SceneBeatSchema = z
  .object({
    role: z.string().optional(),
    actions: z.array(SceneActionSchema).default([]),
    teaching_line: z.string().optional(),
    attention_target: z.string().optional(),
  })
  .passthrough();
export type SceneBeat = z.infer<typeof SceneBeatSchema>;

export const SceneSpecSchema = z
  .object({
    visual_thesis: z.string().optional(),
    essence_rationale: z.string().optional(),
    visual_objects: z.array(VisualObjectSchema).default([]),
    scenes: z.array(SceneBeatSchema).default([]),
    grounding_source: z.string().optional(),
  })
  .passthrough();
export type SceneSpec = z.infer<typeof SceneSpecSchema>;
