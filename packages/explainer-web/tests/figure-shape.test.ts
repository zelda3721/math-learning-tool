/**
 * figure 图元：讲义原图的转写重画（引擎注入坐标 → 保形渲染）。
 * 产品定案 2026-08-15：有原图不贴截图，各形式用自己的语言重画。
 */
import { describe, expect, it } from "vitest";
import { SceneSpecSchema } from "@mathtutor/schema";
import { foldBeats } from "../src/fold.js";
import { solveScene, type FigureShape } from "../src/render/scene.js";
import { layoutFlowed, type Placed, type PlacedFigure } from "../src/render/layout.js";

const W = 900;
const H = 520;
const OPTS = { width: W, height: H, top: 40, bottom: 56 };

const FIGURE_PARAMS = {
  points: [
    { id: "A", at: [0.36, 0.77] },
    { id: "B", at: [0.55, 0.12] },
    { id: "C", at: [0.95, 0.14] },
    { id: "D", at: [0.62, 0.95] },
  ],
  segments: [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
    { from: "C", to: "D" },
    { from: "D", to: "A" },
  ],
  polygons: [{ points: ["A", "B", "D"], shaded: true }],
};

function spec(params: unknown) {
  return SceneSpecSchema.parse({
    visual_objects: [
      { id: "original_figure", primitive: "figure", params, meaning: "讲义原图" },
      { id: "note", primitive: "relation_node", label: "差额 16", meaning: "差额" },
    ],
    scenes: [
      { actions: [{ op: "create", target: "original_figure" }, { op: "create", target: "note" }] },
    ],
  });
}

function solved(params: unknown) {
  const beats = foldBeats(spec(params));
  return solveScene(beats[0]!, W, H);
}

describe("figure 图元（转写重画）", () => {
  it("合法参数解出 figure 形状：点/线/阴影一个不少", () => {
    const scene = solved(FIGURE_PARAMS);
    const fig = scene.flowed.find((s): s is FigureShape => s.kind === "figure");
    expect(fig).toBeDefined();
    expect(fig!.points.map((p) => p.id)).toEqual(["A", "B", "C", "D"]);
    expect(fig!.segments).toHaveLength(4);
    expect(fig!.polygons).toEqual([{ points: ["A", "B", "D"], shaded: true }]);
    // 不该产生 unknown-primitive 告警
    expect(scene.issues.filter((i) => i.kind === "unknown-primitive")).toHaveLength(0);
  });

  it("引用了不存在字母的线段/阴影被丢弃（宁缺毋错）", () => {
    const scene = solved({
      ...FIGURE_PARAMS,
      segments: [...FIGURE_PARAMS.segments, { from: "A", to: "X" }],
      polygons: [{ points: ["A", "B", "X"], shaded: true }],
    });
    const fig = scene.flowed.find((s): s is FigureShape => s.kind === "figure")!;
    expect(fig.segments).toHaveLength(4);
    expect(fig.polygons).toHaveLength(0);
  });

  it("点不足 3 个整体不画，落成占位而不是一张错图", () => {
    const scene = solved({ points: FIGURE_PARAMS.points.slice(0, 2), segments: [], polygons: [] });
    expect(scene.flowed.find((s) => s.kind === "figure")).toBeUndefined();
    const placeholder = scene.flowed.find((s) => s.kind === "label" && s.placeholder);
    expect(placeholder).toBeDefined();
  });

  it("布局给图置顶的框且**保形**：框的长宽比 = 点集包围盒的长宽比", () => {
    const beats = foldBeats(spec(FIGURE_PARAMS));
    const scene = solveScene(beats[0]!, W, H);
    const items: Placed[] = layoutFlowed(scene, OPTS).items;
    const placed = items.find((i): i is PlacedFigure => i.kind === "figure");
    expect(placed).toBeDefined();
    const { box } = placed!;
    // 包围盒：x 0.36~0.95（0.59），y 0.12~0.95（0.83）
    const expected = 0.59 / 0.83;
    const actual = (box.w - 48) / (box.h - 40); // 扣掉字母留边
    expect(actual).toBeCloseTo(expected, 1);
    // 置顶：图在其它内容（差额标签）上方
    const label = items.find((i) => i.kind === "label");
    if (label && "at" in label) expect(box.y).toBeLessThan(label.at.y);
  });
});
