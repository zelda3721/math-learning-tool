import { describe, expect, it } from "vitest";
import { SceneSpecSchema } from "@mathtutor/schema";
import { qualityOf, semanticFindingsOf } from "../src/explain/semantics.js";

/**
 * 生成端语义门禁：不合格的讲解在**产出时**就被标出来，而不是等孩子点了播放。
 *
 * 这里只测"判定与分级"这一层——HTTP 管道不必再走一遍，
 * 因为三条反例本身的语义已经由 @mathtutor/explainer-web 的 gate.test.ts 锁住了。
 */

const parse = (raw: unknown) => SceneSpecSchema.parse(raw);

describe("semanticFindingsOf", () => {
  it("宣称 8 个、画面只有 3 个 → 报 claim-mismatch", () => {
    const spec = parse({
      visual_objects: [{ id: "a", primitive: "unit_grid", params: { total: 3 } }],
      scenes: [
        { actions: [{ op: "appear", target: "a" }] },
        { actions: [{ op: "count", target: "a", expect: 8 }], teaching_line: "一共 8 个" },
      ],
    });
    expect(semanticFindingsOf(spec).map((f) => f.code)).toContain("claim-mismatch");
  });

  it("干净的讲解 → 没有任何发现", () => {
    const spec = parse({
      visual_objects: [
        { id: "a", primitive: "unit_grid", params: { total: 5 } },
        { id: "b", primitive: "unit_grid", params: { total: 0 } },
      ],
      scenes: [
        { actions: [{ op: "appear", target: "a" }] },
        { actions: [{ op: "take_from", source: "a", destination: "b", count: 2 }], teaching_line: "吃掉 2 个" },
      ],
    });
    expect(semanticFindingsOf(spec)).toEqual([]);
  });

  it("门禁自己出问题时返回空数组（它是质量信号，不是安全闸门）", () => {
    const broken = { visual_objects: "not-an-array", scenes: [] } as unknown as ReturnType<typeof parse>;
    expect(semanticFindingsOf(broken)).toEqual([]);
  });
});

describe("qualityOf", () => {
  it("结构或语义任一有问题 → 降到 acceptable", () => {
    const finding = [{ code: "claim-mismatch" as const, beat: 0, detail: "x" }];
    expect(qualityOf([], finding)).toBe("acceptable");
    expect(qualityOf(["无可视对象"], [])).toBe("acceptable");
    expect(qualityOf([], [])).toBe("good");
  });
});
