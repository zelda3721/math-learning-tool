import { describe, expect, it } from "vitest";
import { validateSpec } from "../src/validate.js";

const validSpec = {
  visual_thesis: "9 个苹果拿走 4 个",
  visual_objects: [
    { id: "apples", primitive: "quantity_bar", params: { count: 9 }, label: "苹果" },
    { id: "note", primitive: "relation_node", params: {}, label: "9-4" },
  ],
  scenes: [
    { actions: [{ op: "appear", target: "apples" }], teaching_line: "先摆出 9 个" },
    { actions: [{ op: "take_from", source: "apples", count: 4 }], teaching_line: "拿走 4 个" },
  ],
};

describe("validateSpec", () => {
  it("accepts a valid spec with no errors or warnings", () => {
    const result = validateSpec(validSpec);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.spec).not.toBeNull();
    expect(result.spec!.visual_objects).toHaveLength(2);
  });

  it("rejects non-object input via schema errors", () => {
    const result = validateSpec("not a spec");
    expect(result.spec).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("errors on action referencing a nonexistent object id", () => {
    const result = validateSpec({
      visual_objects: [{ id: "a", primitive: "dot", params: {} }],
      scenes: [{ actions: [{ op: "highlight", target: "ghost" }] }],
    });
    expect(result.spec).toBeNull();
    expect(result.errors.some((e) => e.includes('"ghost"'))).toBe(true);
  });

  it("errors on duplicate object ids", () => {
    const result = validateSpec({
      visual_objects: [
        { id: "a", primitive: "dot", params: {} },
        { id: "a", primitive: "circle", params: {} },
      ],
      scenes: [],
    });
    expect(result.spec).toBeNull();
    expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("warns (but accepts) unknown primitives and ops", () => {
    const result = validateSpec({
      visual_objects: [{ id: "x", primitive: "hologram", params: {} }],
      scenes: [{ actions: [{ op: "teleport", target: "x" }] }],
    });
    expect(result.spec).not.toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes('primitive "hologram"'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('op "teleport"'))).toBe(true);
  });

  it("set_value 写在不支持的对象上 → 警告（静默无效比报错更难查）", () => {
    const result = validateSpec({
      visual_objects: [
        { id: "bar", primitive: "quantity_bar", params: { total: 12 } },
        { id: "dots", primitive: "unit_grid", params: { count: 6 } },
      ],
      scenes: [
        { actions: [{ op: "set_value", target: "bar", value: 9 }] },
        { actions: [{ op: "set_value", target: "dots", value: 3 }] },
      ],
    });
    expect(result.errors).toEqual([]);
    // 量：不警告
    expect(result.warnings.filter((w) => w.includes('"bar"'))).toEqual([]);
    // 集：警告，并说清为什么
    expect(result.warnings.some((w) => w.includes('"dots"') && w.includes("quantity_bar"))).toBe(true);
  });
});
