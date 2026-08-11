import { describe, expect, it } from "vitest";
import { FigureSpecSchema } from "@mathtutor/schema";
import { readFileSync } from "node:fs";
import { checkConstraints, solveFigure } from "../src/figure/solve.js";

const spec = (raw: unknown) => FigureSpecSchema.parse(raw);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const angle = (o: any, a: any, b: any) => {
    const c = ((a.x - o.x) * (b.x - o.x) + (a.y - o.y) * (b.y - o.y)) /
        (Math.hypot(a.x - o.x, a.y - o.y) * Math.hypot(b.x - o.x, b.y - o.y));
    return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
};

describe("几何图求解：坐标是约束的解，不是手填的", () => {
  it("直角三角形 3-4-5：给两直角边和直角，斜边自动是 5", () => {
    const s = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 3 },
        { kind: "length", from: "B", to: "C", value: 4 },
        { kind: "right-angle", at: "B", from: "A", to: "C" },
      ],
    });
    const r = solveFigure(s);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    // 没有声明斜边，但它必须是 5——这正是"图能承担论证"的意思
    expect(dist(r.coords.A!, r.coords.C!)).toBeCloseTo(5, 2);
  });

  it("长方形：两组对边平行 + 邻边垂直 + 给长宽", () => {
    const s = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 8 },
        { kind: "length", from: "B", to: "C", value: 5 },
        { kind: "right-angle", at: "B", from: "A", to: "C" },
        { kind: "right-angle", at: "C", from: "B", to: "D" },
        { kind: "parallel", a: ["A", "B"], b: ["D", "C"] },
        // 两个直角已蕴含 AB∥DC，但 CD 的长度仍是自由的——不补这条，图就是欠定的
        { kind: "equal-length", a: ["D", "C"], b: ["A", "B"] },
      ],
    });
    const r = solveFigure(s);
    expect(r.ok).toBe(true);
    expect(dist(r.coords.A!, r.coords.D!)).toBeCloseTo(5, 1);
    expect(dist(r.coords.D!, r.coords.C!)).toBeCloseTo(8, 1);
  });

  it("等腰三角形：底角相等由等腰约束自然得到", () => {
    const s = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      constraints: [
        { kind: "length", from: "B", to: "C", value: 6 },
        { kind: "equal-length", a: ["A", "B"], b: ["A", "C"] },
        { kind: "length", from: "A", to: "B", value: 5 },
      ],
    });
    const r = solveFigure(s);
    expect(r.ok).toBe(true);
    expect(angle(r.coords.B!, r.coords.A!, r.coords.C!)).toBeCloseTo(
      angle(r.coords.C!, r.coords.A!, r.coords.B!), 1);
  });

  it("给定角度的三角形：60° 就是 60°", () => {
    const s = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 10 },
        { kind: "length", from: "A", to: "C", value: 7 },
        { kind: "angle", at: "A", from: "B", to: "C", degrees: 60 },
      ],
    });
    const r = solveFigure(s);
    expect(r.ok).toBe(true);
    expect(angle(r.coords.A!, r.coords.B!, r.coords.C!)).toBeCloseTo(60, 1);
    // 余弦定理复算：BC² = 100 + 49 - 2·10·7·cos60° = 79
    expect(dist(r.coords.B!, r.coords.C!)).toBeCloseTo(Math.sqrt(79), 1);
  });

  it("中点：on-segment 带比例", () => {
    const s = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "M" }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 12 },
        { kind: "on-segment", point: "M", from: "A", to: "B", ratio: 0.5 },
      ],
    });
    const r = solveFigure(s);
    expect(r.ok).toBe(true);
    expect(dist(r.coords.A!, r.coords.M!)).toBeCloseTo(6, 2);
    expect(dist(r.coords.M!, r.coords.B!)).toBeCloseTo(6, 2);
  });

  it("矛盾的约束必须解不出来，而不是硬画一张差不多的图", () => {
    // 三边 1、2、10 围不成三角形
    const s = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 1 },
        { kind: "length", from: "B", to: "C", value: 2 },
        { kind: "length", from: "A", to: "C", value: 10 },
      ],
    });
    const r = solveFigure(s);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
    // 报错要说得出是哪条对不上
    expect(r.violations.join()).toMatch(/要求长|解出来/);
  });

  it("同一份 spec 每次解出同一张图（可缓存、可比对）", () => {
    const s = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 3 },
        { kind: "length", from: "B", to: "C", value: 4 },
        { kind: "right-angle", at: "B", from: "A", to: "C" },
      ],
    });
    const a = solveFigure(s);
    const b = solveFigure(s);
    expect(a.coords).toEqual(b.coords);
    // 规范固定：第一个点在原点，第二个点在 x 轴正向
    expect(a.coords.A).toEqual({ x: 0, y: 0 });
    expect(a.coords.B!.y).toBeCloseTo(0, 6);
    expect(a.coords.B!.x).toBeGreaterThan(0);
  });

  it("checkConstraints 能独立复核任意一组坐标", () => {
    const s = spec({
      points: [{ id: "A" }, { id: "B" }],
      constraints: [{ kind: "length", from: "A", to: "B", value: 5 }],
    });
    expect(checkConstraints(s, { A: { x: 0, y: 0 }, B: { x: 5, y: 0 } })).toEqual([]);
    expect(checkConstraints(s, { A: { x: 0, y: 0 }, B: { x: 4, y: 0 } })).toHaveLength(1);
  });
});

describe("真实题库里的配图必须与题干、答案自洽", () => {
  it("勾股定理那道题：图上量出的斜边就是答案", () => {
    // 这条守的是整块设计的初衷：图不是配图，是题面的一部分，
    // 它量出来的东西必须和题干说的、答案给的对得上。
    const qs = JSON.parse(
      readFileSync(
        new URL("../../../data/knowledge/questions/seed-demo.json", import.meta.url),
        "utf8",
      ),
    ) as { id: string; answer: string; figure?: unknown }[];
    const q = qs.find((x) => x.id === "geo-demo-1")!;
    expect(q.figure).toBeTruthy();

    const s = solveFigure(FigureSpecSchema.parse(q.figure));
    expect(s.ok).toBe(true);
    const ac = Math.hypot(s.coords.A!.x - s.coords.C!.x, s.coords.A!.y - s.coords.C!.y);
    // 答案是 5，图上量出来也必须是 5——两者由不同途径得到
    expect(ac).toBeCloseTo(Number(q.answer), 2);
  });

  it("题库里每一道带图的题，图都解得出来", () => {
    const qs = JSON.parse(
      readFileSync(
        new URL("../../../data/knowledge/questions/seed-demo.json", import.meta.url),
        "utf8",
      ),
    ) as { id: string; figure?: unknown }[];
    for (const q of qs.filter((x) => x.figure)) {
      const r = solveFigure(FigureSpecSchema.parse(q.figure));
      expect(r.ok, `${q.id} 的配图解不出来：${r.violations.join("；")}`).toBe(true);
    }
  });
});
