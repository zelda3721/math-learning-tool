import { describe, expect, it } from "vitest";
import { SceneSpecSchema } from "@mathtutor/schema";
import { VisualRegistry, defaultVisuals } from "../src/visuals.js";
import { foldBeats } from "../src/fold.js";
import { solveScene } from "../src/render/scene.js";
import { validateSpec } from "../src/validate.js";

/**
 * 视觉词汇插件化：加一门学科的图元不该改播放器代码，只该登记一条。
 *
 * 这些用例验的正是那句话——内置词表不变的前提下，
 * 一个新前缀的图元能走通"校验 → 折叠 → 解算"整条链。
 */

const PHYS = new VisualRegistry([
  // 只加一条：其余仍用内置
  ...defaultVisuals.list(),
  { primitive: "phys.force_arrow", subject: "phys", plotted: true },
]);

describe("视觉词表", () => {
  it("内置词表覆盖现有数学图元，且分类与改造前一致", () => {
    expect(defaultVisuals.isPlotted("function_curve")).toBe(true);
    expect(defaultVisuals.isQuantity("unit_grid")).toBe(true);
    expect(defaultVisuals.isMagnitude("quantity_bar")).toBe(true);
    expect(defaultVisuals.isFigure("figure")).toBe(true);
    // 坐标系类图元不参与"可数量"展开
    expect(defaultVisuals.isQuantity("axes")).toBe(false);
  });

  it("未声明的图元当作装饰：画兜底盒子，而不是崩掉或静默消失", () => {
    expect(defaultVisuals.has("phys.force_arrow")).toBe(false);
    expect(defaultVisuals.isPlotted("phys.force_arrow")).toBe(false);
    expect(defaultVisuals.isQuantity("phys.force_arrow")).toBe(false);
  });

  it("重复声明同一个图元 → 抛错（覆盖语义会让人以为改动生效了）", () => {
    expect(() => defaultVisuals.extend([{ primitive: "dot", plotted: true }])).not.toThrow();
    expect(() => new VisualRegistry([{ primitive: "dot" }, { primitive: "dot" }])).toThrow();
  });

  it("扩展不覆盖已有图元：一门学科声明的 dot 不该替换掉所有人的点", () => {
    const extended = defaultVisuals.extend([{ primitive: "dot", plotted: false, quantity: false }]);
    expect(extended.isPlotted("dot")).toBe(true); // 仍是内置那份
  });
});

describe("新图元走通整条链", () => {
  const spec = SceneSpecSchema.parse({
    visual_objects: [{ id: "f", primitive: "phys.force_arrow", params: { x: 1, y: 2 } }],
    scenes: [{ actions: [{ op: "appear", target: "f" }], teaching_line: "受力" }],
  });

  it("校验器认它（词表里声明过），不报「未知图元」", () => {
    const result = validateSpec(spec, PHYS);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("unknown primitive"))).toBe(false);
    // 不传词表时仍然当作未知：默认装配里没有它，这是诚实的
    expect(validateSpec(spec).warnings.some((w) => w.includes("unknown primitive"))).toBe(true);
  });

  it("分类按词表走：注册成 plotted 就不会被当成可数记号展开", () => {
    const beats = foldBeats(spec, PHYS);
    expect(beats).toHaveLength(1);
    // 没注册 quantity，所以不摊成单位
    expect(beats[0]!.groups[0]!.units).toEqual([]);

    const scene = solveScene(beats[0]!, 640, 380, 600, PHYS);
    // 关键：它没有被当成"可数记号"摊成一堆方块（那是 quantity 组的待遇）
    expect(scene.flowed.some((s2) => s2.id === "f" && s2.kind === "units")).toBe(false);
  });

  /*
   * 这条边界值得记住：词表解决的是**分类**，不是**几何**。
   * 学科要真正画出 `phys.force_arrow`，还得提供形状构造器
   * （scene.ts 里那些 dot/line/curve 的分支）。词表让"它归哪一类"变成数据，
   * 但"它长什么样"仍然是代码——而后者本来就该由学科自己写。
   */

});
