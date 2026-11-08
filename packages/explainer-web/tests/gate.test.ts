import { describe, expect, it } from "vitest";
import { SceneSpecSchema } from "@mathtutor/schema";
import { foldBeats } from "../src/fold.js";
import { gateBeats } from "../src/gate.js";

/**
 * 阶段 2 的 DoD：VISUAL_SEMANTICS §1 的三个反例都必须被判为失败。
 *
 * 这些是**反例**，不是"边界情况"：它们每个都对应一次真实事故或一次真实误判。
 * 门禁放过其中任何一个，就等于那件事会重新发生一次。
 */

const parse = (raw: unknown) => SceneSpecSchema.parse(raw);
const gate = (raw: unknown) => {
  const spec = parse(raw);
  return gateBeats(foldBeats(spec), spec);
};

describe("反例一：宣称的数量和画面对不上", () => {
  it("标着 8、画面上只有 3 → 判失败", () => {
    const findings = gate({
      visual_objects: [{ id: "a", primitive: "unit_grid", params: { total: 3 } }],
      scenes: [
        { actions: [{ op: "appear", target: "a" }] },
        { actions: [{ op: "count", target: "a", expect: 8 }], teaching_line: "一共 8 个" },
      ],
    });
    expect(findings.some((f) => f.code === "claim-mismatch")).toBe(true);
  });

  it("标着 3、画面上确实 3 个 → 通过", () => {
    const findings = gate({
      visual_objects: [{ id: "a", primitive: "unit_grid", params: { total: 3 } }],
      scenes: [
        { actions: [{ op: "appear", target: "a" }] },
        { actions: [{ op: "count", target: "a", expect: 3 }], teaching_line: "一共 3 个" },
      ],
    });
    expect(findings).toEqual([]);
  });
});

describe("反例二：宣称有过程，画面却没动", () => {
  it("声明了「数一遍」但什么都和上一拍一样 → 判失败", () => {
    const findings = gate({
      visual_objects: [
        { id: "a", primitive: "unit_grid", params: { total: 5 } },
        { id: "b", primitive: "unit_grid", params: { total: 0 } },
      ],
      scenes: [
        { actions: [{ op: "appear", target: "a" }] },
        // 写了"分成两份"，却没有任何单位移动——正是"减法从未被展示"那次的形状
        { actions: [{ op: "partition_into", target: "a", into: ["b"] }], teaching_line: "吃掉 2 个" },
      ],
    });
    expect(findings.some((f) => f.code === "process-not-shown")).toBe(true);
  });

  it("合法的停顿（不说自己在做过程）不误伤", () => {
    const findings = gate({
      visual_objects: [{ id: "a", primitive: "unit_grid", params: { total: 5 } }],
      scenes: [
        { actions: [{ op: "appear", target: "a" }], teaching_line: "先看这里有 5 个" },
        { actions: [{ op: "highlight", target: "a" }], teaching_line: "记住这个数" },
      ],
    });
    expect(findings).toEqual([]);
  });

  it("真的搬了单位就不报（过程画出来了）", () => {
    const findings = gate({
      visual_objects: [
        { id: "a", primitive: "unit_grid", params: { total: 5 } },
        { id: "b", primitive: "unit_grid", params: { total: 0 } },
      ],
      scenes: [
        { actions: [{ op: "appear", target: "a" }] },
        { actions: [{ op: "take_from", source: "a", destination: "b", count: 2 }], teaching_line: "吃掉 2 个" },
      ],
    });
    expect(findings).toEqual([]);
  });
});

describe("反例三：验证的是两个空框", () => {
  it("清点一个既没有单位也没有量的组 → 判失败", () => {
    const findings = gate({
      visual_objects: [
        { id: "a", primitive: "unit_grid", params: { total: 2 } },
        { id: "empty", primitive: "unit_grid", params: { total: 0 } },
      ],
      scenes: [
        { actions: [{ op: "appear", target: "a" }] },
        { actions: [{ op: "count", target: "empty", expect: 0 }], teaching_line: "数一数这个框" },
      ],
    });
    expect(findings.some((f) => f.code === "empty-target")).toBe(true);
  });
});
