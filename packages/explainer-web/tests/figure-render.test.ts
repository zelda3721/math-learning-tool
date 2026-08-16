import { describe, expect, it } from "vitest";
import { FigureSpecSchema } from "@mathtutor/schema";
import { renderFigure } from "../src/figure/render.js";

const spec = (raw: unknown) => FigureSpecSchema.parse(raw);

const RIGHT_TRIANGLE = spec({
  points: [{ id: "A" }, { id: "B" }, { id: "C" }],
  segments: [
    { from: "A", to: "B", label: "3 cm" },
    { from: "B", to: "C", label: "4 cm" },
    { from: "C", to: "A" },
  ],
  angles: [{ at: "B", from: "A", to: "C", right: true }],
  constraints: [
    { kind: "length", from: "A", to: "B", value: 3 },
    { kind: "length", from: "B", to: "C", value: 4 },
    { kind: "right-angle", at: "B", from: "A", to: "C" },
  ],
});

describe("配图渲染", () => {
  it("画出线段、顶点名与直角标记", () => {
    const r = renderFigure(RIGHT_TRIANGLE)!;
    expect(r).not.toBeNull();
    expect(r.svg).toContain("<svg");
    expect((r.svg.match(/<line /g) ?? []).length).toBe(3);
    for (const name of ["A", "B", "C"]) expect(r.svg).toContain(`>${name}</text>`);
    expect(r.svg).toContain("3 cm");
    // 直角画成方角（polyline），不是弧
    expect(r.svg).toContain("<polyline");
  });

  it("图内所有内容都在画布内，不出血", () => {
    const r = renderFigure(RIGHT_TRIANGLE, { width: 300 })!;
    const coords = [...r.svg.matchAll(/(?:cx|x1|x2|x)="([\d.]+)"/g)].map((m) => Number(m[1]));
    const ys = [...r.svg.matchAll(/(?:cy|y1|y2|y)="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...coords)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...coords)).toBeLessThanOrEqual(300);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(r.height);
  });

  it("约束矛盾时拒绝出图，而不是画一张差不多的", () => {
    const bad = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      segments: [{ from: "A", to: "B" }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 1 },
        { kind: "length", from: "B", to: "C", value: 2 },
        { kind: "length", from: "A", to: "C", value: 10 },
      ],
    });
    expect(renderFigure(bad)).toBeNull();
  });

  it("阴影多边形画出填充，普通多边形不填", () => {
    const s = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      polygons: [{ points: ["A", "B", "C"], shaded: true }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 4 },
        { kind: "length", from: "B", to: "C", value: 3 },
        { kind: "right-angle", at: "B", from: "A", to: "C" },
      ],
    });
    const r = renderFigure(s)!;
    expect(r.svg).toContain("<polygon");
    expect(r.svg).not.toContain('fill="none" stroke="#16203a" stroke-width="1.5"/><circle');
  });

  it("标签里的尖括号被转义，不会破坏 SVG", () => {
    const s = spec({
      points: [{ id: "A" }, { id: "B" }],
      segments: [{ from: "A", to: "B", label: "<script>x</script>" }],
      constraints: [{ kind: "length", from: "A", to: "B", value: 5 }],
    });
    const r = renderFigure(s)!;
    expect(r.svg).not.toContain("<script>");
    expect(r.svg).toContain("&lt;script&gt;");
  });

  it("同一份 spec 渲染结果稳定（坐标已规范化）", () => {
    expect(renderFigure(RIGHT_TRIANGLE)!.svg).toBe(renderFigure(RIGHT_TRIANGLE)!.svg);
  });
});

describe("分步着色与等量配对渲染", () => {
  const coords = { A: { x: 0, y: 0 }, B: { x: 4, y: 0 }, C: { x: 4, y: 3 }, D: { x: 0, y: 3 } };
  const paired = spec({
    points: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
    segments: [
      { from: "A", to: "B" }, { from: "B", to: "C" }, { from: "C", to: "D" }, { from: "D", to: "A" },
      { from: "A", to: "C" },
    ],
    polygons: [
      { points: ["A", "B", "C"], shaded: true, tone: "gold", pair: 1, label: "6" },
      { points: ["A", "C", "D"], shaded: true, tone: "gold", pair: 1, label: "6" },
    ],
    equal_marks: [{ a: ["A", "B", "C"], b: ["A", "C", "D"], label: "6", tone: "gold" }],
  });

  it("配对的两块同色填充、同色加粗描边，中缝写等号", async () => {
    const { renderSolved } = await import("../src/figure/render.js");
    const r = renderSolved(paired, coords, { width: 320 });
    const polys = r.svg.match(/<polygon [^>]+>/g) ?? [];
    expect(polys).toHaveLength(2);
    for (const p of polys) {
      expect(p).toContain('fill="rgba(232,180,40,.42)"');
      expect(p).toContain('stroke="#b8860b"');
      expect(p).toContain('stroke-width="2.4"');
    }
    expect(r.svg).toMatch(/<text [^>]*fill="#b8860b"[^>]*>=<\/text>/);
    // 等号在两块重心连线的中点：对角线 AC 的中点 (2,1.5) → 画布中心附近
    const eq = r.svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>=<\/text>/)!;
    expect(Math.abs(Number(eq[1]) - 160)).toBeLessThan(2);
    expect(Math.abs(Number(eq[2]) - r.height / 2)).toBeLessThan(2);
    // 两块各自的数值仍在，且没有压在等号上
    expect((r.svg.match(/>6<\/text>/g) ?? []).length).toBe(2);
  });

  it("没有 tone 的阴影仍走默认阴影色（题库配图不受影响）", async () => {
    const { renderSolved } = await import("../src/figure/render.js");
    const plain = spec({
      points: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      polygons: [{ points: ["A", "B", "C"], shaded: true }],
    });
    const r = renderSolved(plain, coords, { width: 320 });
    expect(r.svg).toContain('fill="rgba(43,92,230,.14)"');
    expect(r.svg).not.toContain(">=</text>");
  });
});
