import { z } from "zod";

/**
 * 题目配图的声明式规格。
 *
 * 为什么不存图片：几何题的图和题干必须说同一件事。存位图做不到这点——
 * 「AB = 8」写在题干里，图上那条边到底多长没人核对得了；变式把 8 改成 6，
 * 还得再找一张图。存**规格**则相反：点、线、角与约束写下来，坐标由求解器算，
 * 算完再逐条回代验证——图上量出来的边长角度必须与声明一致，否则不许画。
 *
 * 于是「图文不符」在构造上不可能发生，变式改数字图自动跟着变，
 * 任意分辨率清晰，不占存储，也没有版权问题。
 *
 * 抽象层级取「点线角 + 约束」：不写死坐标（写死就等于把错误固化下来），
 * 让作图意图可读、可校验、可复用。
 */

/** 一个点。`at` 只在无法用约束确定时给出（求解器会把它当作初值/锚点）。 */
export const FigurePointSchema = z.object({
  id: z.string(),
  /** 图上显示的名字，缺省用 id */
  label: z.string().optional(),
  /** 可选锚点坐标；不给则完全由约束解出 */
  at: z.tuple([z.number(), z.number()]).optional(),
});

export const FigureSegmentSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** 边上的标注，如 "8 cm"；不写则不标 */
  label: z.string().optional(),
  /** 辅助线用虚线，题目本身的边用实线 */
  style: z.enum(["solid", "dashed"]).default("solid"),
});

export const FigurePolygonSchema = z.object({
  points: z.array(z.string()).min(3),
  label: z.string().optional(),
  /** 阴影部分（求面积题常用） */
  shaded: z.boolean().default(false),
});

export const FigureCircleSchema = z.object({
  center: z.string(),
  /** 半径：直接给数值，或给圆上一点 */
  radius: z.number().optional(),
  through: z.string().optional(),
  label: z.string().optional(),
});

/** 角标记（直角画方角，其余画弧并可标度数） */
export const FigureAngleSchema = z.object({
  at: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  right: z.boolean().default(false),
});

/**
 * 约束：图形真正的定义在这里，坐标是它的解。
 * 求解后逐条回代检查，不满足就拒绝出图。
 */
export const FigureConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("length"), from: z.string(), to: z.string(), value: z.number().positive() }),
  z.object({ kind: z.literal("equal-length"), a: z.tuple([z.string(), z.string()]), b: z.tuple([z.string(), z.string()]) }),
  z.object({ kind: z.literal("angle"), at: z.string(), from: z.string(), to: z.string(), degrees: z.number() }),
  z.object({ kind: z.literal("right-angle"), at: z.string(), from: z.string(), to: z.string() }),
  z.object({ kind: z.literal("parallel"), a: z.tuple([z.string(), z.string()]), b: z.tuple([z.string(), z.string()]) }),
  z.object({ kind: z.literal("perpendicular"), a: z.tuple([z.string(), z.string()]), b: z.tuple([z.string(), z.string()]) }),
  /** 点在线段上；ratio 从 from 起算的比例（0..1），不给则只要求共线且介于两端之间 */
  z.object({ kind: z.literal("on-segment"), point: z.string(), from: z.string(), to: z.string(), ratio: z.number().min(0).max(1).optional() }),
]);

export const FigureSpecSchema = z.object({
  points: z.array(FigurePointSchema).min(2),
  segments: z.array(FigureSegmentSchema).default([]),
  polygons: z.array(FigurePolygonSchema).default([]),
  circles: z.array(FigureCircleSchema).default([]),
  angles: z.array(FigureAngleSchema).default([]),
  constraints: z.array(FigureConstraintSchema).default([]),
  /** 给读者的一句话（如"图中阴影部分为所求"）；不参与作图 */
  note: z.string().optional(),
});

export type FigurePoint = z.infer<typeof FigurePointSchema>;
export type FigureSegment = z.infer<typeof FigureSegmentSchema>;
export type FigurePolygon = z.infer<typeof FigurePolygonSchema>;
export type FigureCircle = z.infer<typeof FigureCircleSchema>;
export type FigureAngle = z.infer<typeof FigureAngleSchema>;
export type FigureConstraint = z.infer<typeof FigureConstraintSchema>;
export type FigureSpec = z.infer<typeof FigureSpecSchema>;
