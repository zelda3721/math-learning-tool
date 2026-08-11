/**
 * 拿真模型（qwen3.6-27b）对真讲义页跑出来的配图规格喂门禁。
 * 这些字段写法不是我编的，是实机输出——门禁对不上它们，配图就永远进不来。
 */
import { describe, expect, it } from "vitest";
import { checkFigure } from "../src/ingest/figureGate.js";

const 平行四边形STEM = "已知平行四边形ABCD的面积是48平方厘米，高AE=8厘米，求CD是多少厘米？";
const 梯形STEM = "已知直角梯形ABCD的面积为48平方厘米,AB=6厘米,CD=10厘米,求直角梯形ABCD的高AD是多少厘米.";

describe("真模型输出过门禁", () => {
  it("平行四边形：parallel 写成 from/to+from2/to2、on-segment 写成 at，都要能收下", () => {
    const raw = {
      points: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }, { id: "E" }],
      segments: [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
        { from: "C", to: "D" },
        { from: "D", to: "A" },
        { from: "A", to: "E", label: "8" },
      ],
      angles: [{ at: "E", from: "A", to: "C", right: true }],
      polygons: [{ points: ["A", "B", "C", "D"], shaded: false }],
      constraints: [
        { kind: "parallel", from: "A", to: "B", from2: "D", to2: "C" },
        { kind: "parallel", from: "A", to: "D", from2: "B", to2: "C" },
        { kind: "perpendicular", from: "A", to: "E", from2: "D", to2: "C" },
        { kind: "on-segment", at: "E", from: "D", to: "C" },
        { kind: "length", from: "A", to: "E", value: 8 },
      ],
    };
    const out = checkFigure(raw, 平行四边形STEM);
    expect(out.rejected).toBeUndefined();
    expect(out.figure?.constraints).toContainEqual({ kind: "parallel", a: ["A", "B"], b: ["D", "C"] });
    expect(out.figure?.constraints).toContainEqual({ kind: "on-segment", point: "E", from: "D", to: "C" });
  });

  it("直角梯形：这一份本来就合规，照常通过", () => {
    const raw = {
      points: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
      segments: [
        { from: "A", to: "B", label: "6 厘米" },
        { from: "B", to: "C" },
        { from: "C", to: "D", label: "10 厘米" },
        { from: "D", to: "A" },
      ],
      angles: [{ at: "D", from: "A", to: "C", right: true }],
      polygons: [{ points: ["A", "B", "C", "D"], shaded: false }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 6 },
        { kind: "length", from: "C", to: "D", value: 10 },
        { kind: "right-angle", at: "D", from: "A", to: "C" },
        { kind: "parallel", from: "A", to: "B", from2: "D", to2: "C" },
      ],
    };
    const out = checkFigure(raw, 梯形STEM);
    expect(out.rejected).toBeUndefined();
    expect(out.figure?.constraints).toContainEqual({ kind: "parallel", a: ["A", "B"], b: ["D", "C"] });
  });

  it("这道题的答案是 6，配图里不许出现 6——那是要孩子算的", () => {
    const raw = {
      points: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }, { id: "E" }],
      segments: [{ from: "D", to: "C", label: "6" }],
      constraints: [
        { kind: "length", from: "A", to: "E", value: 8 },
        { kind: "length", from: "D", to: "C", value: 6 },
      ],
    };
    // 平行四边形那道题的题干里没有 6（48 和 8 才有）
    expect(checkFigure(raw, 平行四边形STEM).rejected).toContain("题干没有的条件");
  });
});

describe("拦住不是图的东西", () => {
  const stem = "下图的手绢里共有多少个三角形？";

  /**
   * 实测：一道数三角形的题，模型给了 52 个点（A…zz）、几百条线段、零条约束。
   * 它在描摹像素，不是在描述结构。
   */
  it("一条约束都没有的图要拒收——位置全是随意摆的", () => {
    const raw = {
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      segments: [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
        { from: "C", to: "A" },
      ],
      constraints: [],
    };
    expect(checkFigure(raw, stem).rejected).toContain("没有任何约束");
  });

  it("点多到超出字母表也拒收", () => {
    const raw = {
      points: Array.from({ length: 52 }, (_, i) => ({ id: `p${i}` })),
      segments: [{ from: "p0", to: "p1" }],
      constraints: [{ kind: "length", from: "p0", to: "p1", value: 3 }],
    };
    expect(checkFigure(raw, "一条线段长 3 厘米").rejected).toContain("52 个点");
  });

  it("正常的三角形不受影响", () => {
    const raw = {
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      segments: [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
        { from: "C", to: "A" },
      ],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 3 },
        { kind: "length", from: "B", to: "C", value: 4 },
        { kind: "right-angle", at: "B", from: "A", to: "C" },
      ],
    };
    expect(checkFigure(raw, "直角三角形两直角边分别是 3 厘米和 4 厘米，斜边多长？").rejected).toBeUndefined();
  });
});
