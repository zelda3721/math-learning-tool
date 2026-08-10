import { describe, expect, it } from "vitest";
import { SceneSpecSchema } from "@mathtutor/schema";
import { foldBeats } from "../src/fold.js";

const parse = (raw: unknown) => SceneSpecSchema.parse(raw);

describe("foldBeats", () => {
  it("appear order controls per-beat visibility", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "a", primitive: "dot", params: {} },
          { id: "b", primitive: "dot", params: {} },
        ],
        scenes: [
          { actions: [{ op: "appear", target: "a" }] },
          { actions: [{ op: "reveal", target: "b" }], teaching_line: "b 登场" },
        ],
      }),
    );
    expect(beats).toHaveLength(2);
    expect(beats[0]!.objects.map((o) => o.id)).toEqual(["a"]);
    expect(beats[1]!.objects.map((o) => o.id)).toEqual(["a", "b"]);
    expect(beats[1]!.teachingLine).toBe("b 登场");
    // appear 的那一拍带 emphasis，下一拍重置
    expect(beats[0]!.objects[0]!.emphasis).toBe(true);
    expect(beats[1]!.objects.find((o) => o.id === "a")!.emphasis).toBeUndefined();
  });

  it("take_from accumulates removedCount and marks emphasis", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "apples", primitive: "quantity_bar", params: { count: 9 } }],
        scenes: [
          { actions: [] },
          { actions: [{ op: "take_from", source: "apples", count: 4 }] },
          { actions: [{ op: "take_from", source: "apples", count: 2 }] },
        ],
      }),
    );
    expect(beats[0]!.objects[0]!.removedCount).toBeUndefined();
    expect(beats[0]!.objects[0]!.count).toBe(9);
    expect(beats[1]!.objects[0]!.removedCount).toBe(4);
    expect(beats[1]!.objects[0]!.emphasis).toBe(true);
    expect(beats[2]!.objects[0]!.removedCount).toBe(6);
  });

  it("all objects visible from beat 0 when spec has no appear/reveal at all", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "a", primitive: "dot", params: {} },
          { id: "b", primitive: "circle", params: {} },
        ],
        scenes: [{ actions: [{ op: "highlight", target: "a" }] }],
      }),
    );
    expect(beats[0]!.objects.map((o) => o.id)).toEqual(["a", "b"]);
    expect(beats[0]!.objects.find((o) => o.id === "a")!.emphasis).toBe(true);
  });

  it("unknown ops are ignored without breaking visibility", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "a", primitive: "dot", params: {} }],
        scenes: [
          { actions: [{ op: "appear", target: "a" }] },
          { actions: [{ op: "quantum_flip", target: "a" }, { op: "warp" }] },
        ],
      }),
    );
    expect(beats[1]!.objects.map((o) => o.id)).toEqual(["a"]);
  });

  it("attention_target marks emphasis; empty scenes yield one all-visible beat", () => {
    const withAttention = foldBeats(
      parse({
        visual_objects: [{ id: "a", primitive: "dot", params: {} }],
        scenes: [{ actions: [], attention_target: "a" }],
      }),
    );
    expect(withAttention[0]!.objects[0]!.emphasis).toBe(true);

    const noScenes = foldBeats(
      parse({ visual_objects: [{ id: "a", primitive: "dot", params: {} }], scenes: [] }),
    );
    expect(noScenes).toHaveLength(1);
    expect(noScenes[0]!.objects.map((o) => o.id)).toEqual(["a"]);

    expect(foldBeats(parse({ visual_objects: [], scenes: [] }))).toEqual([]);
  });
});
