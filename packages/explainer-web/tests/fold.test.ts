import { describe, expect, it } from "vitest";
import { SceneSpecSchema } from "@mathtutor/schema";
import { foldBeats, MAX_UNITS_PER_GROUP, type BeatState, type GroupState } from "../src/fold.js";

const parse = (raw: unknown) => SceneSpecSchema.parse(raw);
const group = (beat: BeatState, id: string): GroupState => {
  const found = beat.groups.find((g) => g.id === id);
  if (!found) throw new Error(`group ${id} 不在这一拍里：${beat.groups.map((g) => g.id).join(",")}`);
  return found;
};
const qty = (beat: BeatState, id: string): number =>
  beat.groups.find((g) => g.id === id)?.units.reduce((s, u) => s + (u.weight ?? 1), 0) ?? 0;
const total = (beat: BeatState): number =>
  beat.groups.reduce((s, g) => s + g.units.reduce((n, u) => n + (u.weight ?? 1), 0), 0);

describe("foldBeats: 可见性与既有语义", () => {
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
    expect(beats[0]!.groups.map((g) => g.id)).toEqual(["a"]);
    expect(beats[1]!.groups.map((g) => g.id)).toEqual(["a", "b"]);
    expect(beats[1]!.teachingLine).toBe("b 登场");
    expect(beats[0]!.groups[0]!.emphasis).toBe(true);
    expect(group(beats[1]!, "a").emphasis).toBeUndefined();
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
    expect(beats[0]!.groups.map((g) => g.id)).toEqual(["a", "b"]);
    expect(group(beats[0]!, "a").emphasis).toBe(true);
  });

  it("unknown ops are ignored without breaking visibility", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "a", primitive: "unit_grid", params: { count: 3 } }],
        scenes: [
          { actions: [{ op: "appear", target: "a" }] },
          {
            actions: [
              { op: "quantum_flip", target: "a" },
              { op: "warp" },
              { op: "take_from" },
              { op: "combine" },
              { op: "partition_into", source: "a" },
              { op: "replicate", source: "a" },
              { op: "count" },
              { op: "swap_units" },
              { op: "balance_remove" },
            ],
          },
        ],
      }),
    );
    expect(beats[1]!.groups.map((g) => g.id)).toEqual(["a"]);
    expect(qty(beats[1]!, "a")).toBe(3);
  });

  it("attention_target marks emphasis; empty scenes yield one all-visible beat", () => {
    const withAttention = foldBeats(
      parse({
        visual_objects: [{ id: "a", primitive: "dot", params: {} }],
        scenes: [{ actions: [], attention_target: "a" }],
      }),
    );
    expect(withAttention[0]!.groups[0]!.emphasis).toBe(true);

    const noScenes = foldBeats(
      parse({ visual_objects: [{ id: "a", primitive: "dot", params: {} }], scenes: [] }),
    );
    expect(noScenes).toHaveLength(1);
    expect(noScenes[0]!.groups.map((g) => g.id)).toEqual(["a"]);

    expect(foldBeats(parse({ visual_objects: [], scenes: [] }))).toEqual([]);
  });
});

describe("foldBeats: 单位展开", () => {
  it("count / total 展开成有身份的单位；非数量图元不展开", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "grid", primitive: "unit_grid", params: { count: 4 } },
          { id: "box", primitive: "rectangle", params: { total: 2 } },
          { id: "half", primitive: "quantity_bar", params: { value: 2.5 } },
          { id: "axes", primitive: "axes", params: { total: 10 } },
        ],
        scenes: [{ actions: [] }],
      }),
    );
    const beat = beats[0]!;
    expect(group(beat, "grid").units.map((u) => u.id)).toEqual([
      "grid#0",
      "grid#1",
      "grid#2",
      "grid#3",
    ]);
    expect(group(beat, "grid").units.map((u) => u.index)).toEqual([0, 1, 2, 3]);
    expect(group(beat, "box").units).toHaveLength(2);
    // 小数量不是"几个一"，不许假装数得清
    expect(group(beat, "half").units).toEqual([]);
    expect(group(beat, "axes").units).toEqual([]);
  });

  it("quantity_bar 的 value 是「量」不是「集」：给 magnitude，不摊成一堆点", () => {
    // 70 只脚摊成 70 个点，既数不清也比不出 70 与 94 的差——量的意义就在长短对比。
    // 引擎 Manim 通道一直把 quantity_bar 画成长度正比于 value 的条，这里补齐同一语义。
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "baseline", primitive: "quantity_bar", params: { value: 70 } },
          { id: "target", primitive: "quantity_bar", params: { value: 94 } },
          // 条上明确给 count 时仍是可数的集：单位照常展开，take_from 才搬得动
          { id: "countable", primitive: "quantity_bar", params: { count: 6 } },
        ],
        scenes: [{ actions: [] }],
      }),
    );
    const beat = beats[0]!;
    expect(group(beat, "baseline").magnitude).toBe(70);
    expect(group(beat, "baseline").units).toEqual([]);
    expect(group(beat, "baseline").quantity).toBeUndefined();
    expect(group(beat, "target").magnitude).toBe(94);
    expect(group(beat, "countable").magnitude).toBeUndefined();
    expect(group(beat, "countable").units).toHaveLength(6);
  });

  it("spec 声明的语义色名传给播放器（播放器自己映射配色盘，不直接当 CSS 用）", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "a", primitive: "unit_grid", params: { count: 2 }, color: "yellow" },
          { id: "b", primitive: "unit_grid", params: { count: 2 } },
        ],
        scenes: [{ actions: [] }],
      }),
    );
    expect(group(beats[0]!, "a").color).toBe("yellow");
    expect(group(beats[0]!, "b").color).toBeUndefined();
  });

  it("超过上限时聚合为「每单位代表 N」，且 Σweight 仍等于真实数量", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "big", primitive: "unit_grid", params: { count: 1000 } }],
        scenes: [{ actions: [] }],
      }),
    );
    const big = group(beats[0]!, "big");
    expect(big.units.length).toBeLessThanOrEqual(MAX_UNITS_PER_GROUP);
    expect(big.unitScale).toBe(5);
    expect(big.note).toContain("5");
    expect(big.units.reduce((s, u) => s + (u.weight ?? 1), 0)).toBe(1000);
    expect(big.quantity).toBe(1000);
  });
});

describe("foldBeats: take_from（拿走 = 具体单位搬家，守恒可见）", () => {
  const spec = parse({
    visual_objects: [
      { id: "apples", primitive: "unit_grid", params: { count: 9 } },
      { id: "basket", primitive: "rectangle", params: {} },
    ],
    scenes: [
      { actions: [] },
      { actions: [{ op: "take_from", source: "apples", destination: "basket", count: 4 }] },
      { actions: [{ op: "take_from", source: "apples", count: 2 }] },
    ],
  });

  it("源组变少、目标组变多、总量守恒，且搬的是原来那些单位", () => {
    const beats = foldBeats(spec);
    expect(qty(beats[0]!, "apples")).toBe(9);
    expect(beats[0]!.conservation).toBeUndefined();

    const b1 = beats[1]!;
    expect(qty(b1, "apples")).toBe(5);
    expect(qty(b1, "basket")).toBe(4);
    expect(b1.conservation).toEqual({ before: 9, after: 9, ok: true });
    expect(b1.moves).toHaveLength(4);
    expect(b1.moves.every((m) => m.from === "apples" && m.to === "basket")).toBe(true);
    // 身份保留：篮子里的就是原来那几个苹果
    expect(group(b1, "basket").units.map((u) => u.id)).toEqual([
      "apples#0",
      "apples#1",
      "apples#2",
      "apples#3",
    ]);
    expect(group(b1, "basket").units.every((u) => u.origin === "apples")).toBe(true);
    expect(group(b1, "basket").units.map((u) => u.index)).toEqual([0, 1, 2, 3]);
  });

  it("没有 destination 时进入残影组：单位不凭空消失，总量仍然对得上", () => {
    const beats = foldBeats(spec);
    const b2 = beats[2]!;
    expect(qty(b2, "apples")).toBe(3);
    const ghost = group(b2, "apples__removed");
    expect(ghost.ghost).toBe(true);
    expect(ghost.synthetic).toBe(true);
    expect(ghost.derivedFrom).toBe("apples");
    expect(ghost.units.map((u) => u.id)).toEqual(["apples#4", "apples#5"]);
    expect(total(b2)).toBe(9);
    expect(b2.conservation).toEqual({ before: 9, after: 9, ok: true });
  });

  it("宣称拿走的比实际能拿的多 → counts 里暴露，不许静默夹带", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "g", primitive: "unit_grid", params: { count: 2 } }],
        scenes: [{ actions: [{ op: "take_from", source: "g", count: 5 }] }],
      }),
    );
    expect(beats[0]!.counts).toEqual([{ groupId: "g__removed", claimed: 5, actual: 2 }]);
    expect(total(beats[0]!)).toBe(2);
  });
});

describe("foldBeats: combine（合并 = 单位身份保留）", () => {
  it("多组单位合并到目标组，看得出这些就是原来那些", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "first", primitive: "unit_grid", params: { count: 3 } },
          { id: "second", primitive: "unit_grid", params: { count: 4 } },
          { id: "sum", primitive: "rectangle", params: {} },
        ],
        scenes: [
          { actions: [{ op: "combine", targets: ["first", "second"], result: "sum" }] },
          { actions: [{ op: "count", targets: ["sum"], expect: 7 }] },
        ],
      }),
    );
    const b0 = beats[0]!;
    expect(qty(b0, "first")).toBe(0);
    expect(qty(b0, "second")).toBe(0);
    expect(qty(b0, "sum")).toBe(7);
    expect(group(b0, "sum").units.map((u) => u.id)).toEqual([
      "first#0",
      "first#1",
      "first#2",
      "second#0",
      "second#1",
      "second#2",
      "second#3",
    ]);
    expect(group(b0, "sum").units.filter((u) => u.origin === "second")).toHaveLength(4);
    expect(b0.conservation).toEqual({ before: 7, after: 7, ok: true });
    // 下一拍数一遍，宣称与实际一致
    expect(beats[1]!.counts).toEqual([{ groupId: "sum", claimed: 7, actual: 7 }]);
  });

  it("sources/destination 形态与 targets/result 形态等价", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "a", primitive: "unit_grid", params: { count: 2 } },
          { id: "b", primitive: "unit_grid", params: { count: 2 } },
        ],
        scenes: [{ actions: [{ op: "combine", sources: ["a", "b"], destination: "pile" }] }],
      }),
    );
    expect(qty(beats[0]!, "pile")).toBe(4);
    expect(group(beats[0]!, "pile").synthetic).toBe(true);
    expect(beats[0]!.conservation!.ok).toBe(true);
  });
});

describe("foldBeats: partition_into（除不尽要看得见）", () => {
  it("均分成 parts 组，余数单独成组并标注", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "cake", primitive: "unit_grid", params: { count: 7 } }],
        scenes: [{ actions: [{ op: "partition_into", source: "cake", parts: 3 }] }],
      }),
    );
    const beat = beats[0]!;
    expect(qty(beat, "cake__part1")).toBe(2);
    expect(qty(beat, "cake__part2")).toBe(2);
    expect(qty(beat, "cake__part3")).toBe(2);
    const rest = group(beat, "cake__remainder");
    expect(rest.remainder).toBe(true);
    expect(rest.units).toHaveLength(1);
    expect(rest.note).toBe("7 ÷ 3 = 2 余 1");
    expect(qty(beat, "cake")).toBe(0);
    expect(beat.conservation).toEqual({ before: 7, after: 7, ok: true });
  });

  it("整除时没有余数组", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "cake", primitive: "unit_grid", params: { count: 6 } }],
        scenes: [{ actions: [{ op: "partition_into", source: "cake", parts: 3 }] }],
      }),
    );
    expect(beats[0]!.groups.some((g) => g.id === "cake__remainder")).toBe(false);
    expect(qty(beats[0]!, "cake__part3")).toBe(2);
  });
});

describe("foldBeats: replicate（几个几）", () => {
  it("复制 times 份到目标组，新单位标记来源与份号", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "row", primitive: "unit_grid", params: { count: 3 } },
          { id: "product", primitive: "rectangle", params: {} },
        ],
        scenes: [
          {
            actions: [{ op: "replicate", source: "row", result: "product", count: 4 }],
          },
        ],
      }),
    );
    const beat = beats[0]!;
    expect(qty(beat, "product")).toBe(12);
    expect(qty(beat, "row")).toBe(3);
    expect(group(beat, "product").units.every((u) => u.origin === "row")).toBe(true);
    expect([...new Set(group(beat, "product").units.map((u) => u.copy))]).toEqual([0, 1, 2, 3]);
    expect(new Set(group(beat, "product").units.map((u) => u.id)).size).toBe(12);
    // 故意变多的一拍不做守恒断言（守恒不成立才是对的）
    expect(beat.conservation).toBeUndefined();
    expect(beat.moves).toHaveLength(12);
  });

  it("没有目标组时就地复制：总数正好是 times × n，不滚雪球", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "row", primitive: "unit_grid", params: { count: 3 } }],
        scenes: [{ actions: [{ op: "replicate", source: "row", times: 4 }] }],
      }),
    );
    expect(qty(beats[0]!, "row")).toBe(12);
  });
});

describe("foldBeats: count / recount_verify（验算必须能揭穿）", () => {
  it("claimed ≠ actual 时被暴露", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "g", primitive: "unit_grid", params: { count: 5 } }],
        scenes: [
          { actions: [{ op: "count", targets: ["g"], expect: 5 }] },
          { actions: [{ op: "recount_verify", targets: ["g"], expect: 7 }] },
        ],
      }),
    );
    expect(beats[0]!.counts).toEqual([{ groupId: "g", claimed: 5, actual: 5 }]);
    expect(beats[1]!.counts).toEqual([{ groupId: "g", claimed: 7, actual: 5 }]);
  });

  it("数不出单位的对象不产生计数事实（不假警报，也不假背书）", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "node", primitive: "relation_node", params: {} },
          { id: "axes", primitive: "axes", params: { x_range: [0, 10] } },
        ],
        scenes: [
          {
            actions: [
              { op: "count", targets: ["node"], expect: 9 },
              { op: "recount_verify", targets: ["node", "axes"], expect_total: 9 },
            ],
          },
        ],
      }),
    );
    expect(beats[0]!.counts).toEqual([]);
    expect(beats[0]!.conservation).toBeUndefined();
    expect(group(beats[0]!, "node").emphasis).toBe(true);
  });

  it("容器一旦接收过单位，就要接受核对（空了也照报）", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "src", primitive: "unit_grid", params: { count: 3 } },
          { id: "box", primitive: "rectangle", params: {} },
        ],
        scenes: [
          { actions: [{ op: "count", targets: ["box"], expect: 3 }] },
          { actions: [{ op: "combine", targets: ["src"], result: "box" }] },
          { actions: [{ op: "combine", targets: ["box"], result: "src" }] },
          { actions: [{ op: "count", targets: ["box"], expect: 3 }] },
        ],
      }),
    );
    // 第 0 拍 box 还从没承载过单位 → 无从核对
    expect(beats[0]!.counts).toEqual([]);
    // 搬空之后再宣称有 3 个 → 必须暴露
    expect(beats[3]!.counts).toEqual([{ groupId: "box", claimed: 3, actual: 0 }]);
  });

  it("expect_total 与两组实际合计不符时，守恒检查判 false", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "left", primitive: "unit_grid", params: { count: 9 } },
          { id: "gone", primitive: "rectangle", params: {} },
        ],
        scenes: [
          { actions: [{ op: "take_from", source: "left", destination: "gone", count: 4 }] },
          { actions: [{ op: "recount_verify", targets: ["left", "gone"], expect_total: 9 }] },
          { actions: [{ op: "recount_verify", targets: ["left", "gone"], expect_total: 10 }] },
        ],
      }),
    );
    expect(beats[1]!.conservation).toEqual({ before: 9, after: 9, ok: true });
    expect(beats[1]!.counts).toEqual([
      { groupId: "left", claimed: 5, actual: 5 },
      { groupId: "gone", claimed: 4, actual: 4 },
    ]);
    expect(beats[2]!.conservation).toEqual({ before: 10, after: 9, ok: false });
  });
});

describe("foldBeats: swap_units / 天平（不变性可见）", () => {
  it("a/b 两组对调同样多的单位，总量不变", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "a", primitive: "unit_grid", params: { count: 3 } },
          { id: "b", primitive: "unit_grid", params: { count: 3 } },
        ],
        scenes: [{ actions: [{ op: "swap_units", a: "a", b: "b", count: 2 }] }],
      }),
    );
    const beat = beats[0]!;
    expect(qty(beat, "a")).toBe(3);
    expect(qty(beat, "b")).toBe(3);
    expect(group(beat, "a").units.filter((u) => u.origin === "b")).toHaveLength(2);
    expect(group(beat, "b").units.filter((u) => u.origin === "a")).toHaveLength(2);
    expect(beat.conservation).toEqual({ before: 6, after: 6, ok: true });
  });

  it("假设法形态：同组内替换 count 个单位，数量守恒、类别改变；换不动就暴露", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "mix", primitive: "unit_grid", params: { count: 8 } }],
        scenes: [
          { actions: [{ op: "swap_units", source: "mix", count: 3, expect_total: 94 }] },
          { actions: [{ op: "swap_units", source: "mix", count: 99 }] },
        ],
      }),
    );
    expect(group(beats[0]!, "mix").units.filter((u) => u.swapped)).toHaveLength(3);
    expect(qty(beats[0]!, "mix")).toBe(8);
    expect(beats[0]!.conservation).toEqual({ before: 8, after: 8, ok: true });
    expect(beats[0]!.counts).toEqual([]);
    // 只剩 5 个可换，却宣称换 99 个
    expect(beats[1]!.counts).toEqual([{ groupId: "mix", claimed: 99, actual: 5 }]);
  });

  it("balance_remove / balance_divide 对两盘同时施加，等式不变、单位不丢", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          {
            id: "eq",
            primitive: "balance",
            params: { coefficient: 3, constant: 2, total: 14, solution: 4, variable: "x" },
          },
        ],
        scenes: [
          { actions: [{ op: "create", targets: ["eq"] }] },
          { actions: [{ op: "balance_remove", targets: ["eq"], count: 2 }] },
          { actions: [{ op: "balance_divide", targets: ["eq"], count: 3 }] },
        ],
      }),
    );
    const setup = group(beats[0]!, "eq");
    expect(setup.units.filter((u) => u.side === "left" && u.kind === "unknown")).toHaveLength(3);
    expect(setup.units.filter((u) => u.side === "left" && u.kind === "unit")).toHaveLength(2);
    expect(setup.units.filter((u) => u.side === "right")).toHaveLength(14);

    const removed = beats[1]!;
    expect(group(removed, "eq").units.filter((u) => u.side === "left" && u.kind === "unit")).toEqual(
      [],
    );
    expect(group(removed, "eq").units.filter((u) => u.side === "right")).toHaveLength(12);
    expect(group(removed, "eq").params).toMatchObject({ constant: 0, total: 12 });
    expect(removed.equality).toEqual({ left: 12, right: 12, ok: true });
    // 拿走的进残影组，总单位数守恒
    expect(qty(removed, "eq__removed")).toBe(4);
    expect(removed.conservation).toEqual({ before: 19, after: 19, ok: true });

    const divided = beats[2]!;
    expect(group(divided, "eq").units.filter((u) => u.kind === "unknown")).toHaveLength(1);
    expect(group(divided, "eq").units.filter((u) => u.side === "right")).toHaveLength(4);
    expect(group(divided, "eq").params).toMatchObject({ coefficient: 1, total: 4 });
    expect(divided.equality).toEqual({ left: 4, right: 4, ok: true });
    expect(divided.conservation!.ok).toBe(true);
  });
});

describe("foldBeats: 引擎真实计划形态（take_away 模板逐字复刻）", () => {
  // 逐字对齐 visual_plan.py 的 take_away 模板：actions 一律带 result: ""，
  // 引用走 targets/source/destination，计数宣称走 expect / expect_total。
  const beats = foldBeats(
    parse({
      visual_objects: [
        {
          id: "story_total",
          primitive: "unit_grid",
          meaning: "最初的苹果",
          label: "苹果",
          params: { count: 9, columns: 3 },
        },
        {
          id: "story_removed",
          primitive: "rectangle",
          meaning: "被拿走的苹果的容器",
          label: "拿走",
          params: {},
        },
      ],
      scenes: [
        {
          role: "setup",
          teaching_line: "先把苹果一个一个数清楚。",
          actions: [
            { op: "create", targets: ["story_total"], result: "", meaning: "建立全部苹果" },
            {
              op: "count",
              targets: ["story_total"],
              result: "",
              expect: 9,
              meaning: "逐个数出总数",
            },
          ],
        },
        {
          role: "transform",
          teaching_line: "在 9 个的基础上消失 2 个，剩下的就是答案。",
          actions: [
            {
              op: "take_from",
              targets: ["story_total"],
              result: "",
              source: "story_total",
              destination: "story_removed",
              count: 2,
              style: "cross_out",
              meaning: "在原地逐个划去 2 个苹果",
            },
            {
              op: "count",
              targets: ["story_total"],
              result: "",
              expect: 7,
              meaning: "逐个数出剩余数量",
            },
          ],
        },
        {
          role: "verify",
          teaching_line: "剩下的加上拿走的，应当还是原来的总数。",
          actions: [
            {
              op: "recount_verify",
              targets: ["story_total", "story_removed"],
              result: "",
              expect_total: 9,
              meaning: "重新数两组并合计核对",
            },
          ],
        },
      ],
    }),
  );

  it("setup 拍数出总数，宣称与实际一致", () => {
    expect(beats[0]!.role).toBe("setup");
    expect(beats[0]!.counts).toEqual([{ groupId: "story_total", claimed: 9, actual: 9 }]);
    expect(qty(beats[0]!, "story_total")).toBe(9);
  });

  it("transform 拍：2 个具体单位搬进容器，剩 7，总量守恒", () => {
    const beat = beats[1]!;
    expect(beat.moves.map((m) => m.unitId)).toEqual(["story_total#0", "story_total#1"]);
    expect(beat.moves.every((m) => m.to === "story_removed")).toBe(true);
    expect(qty(beat, "story_total")).toBe(7);
    expect(qty(beat, "story_removed")).toBe(2);
    expect(beat.counts).toEqual([{ groupId: "story_total", claimed: 7, actual: 7 }]);
    expect(beat.conservation).toEqual({ before: 9, after: 9, ok: true });
  });

  it("verify 拍：两组重数合计回到 9", () => {
    const beat = beats[2]!;
    expect(beat.counts).toEqual([
      { groupId: "story_total", claimed: 7, actual: 7 },
      { groupId: "story_removed", claimed: 2, actual: 2 },
    ]);
    expect(beat.conservation).toEqual({ before: 9, after: 9, ok: true });
  });
});

describe("foldBeats: 旧播放器兼容视图", () => {
  it("objects 仍是声明过的可见对象，count/removedCount 语义不变", () => {
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
    // 派生出来的残影组不混进旧视图
    expect(beats[2]!.objects.map((o) => o.id)).toEqual(["apples"]);
  });
});

describe("foldBeats: 分幕登场（讲解不能一开场就把答案摆出来）", () => {
  it("spec 用了引入动词，被点名的对象就按拍登场；remove 真的收回去", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "card", primitive: "rectangle", params: {}, label: "题目" },
          { id: "start", primitive: "unit_grid", params: { count: 5 } },
          { id: "answer", primitive: "unit_grid", params: { count: 2 }, label: "答案" },
        ],
        scenes: [
          {
            actions: [
              { op: "create", targets: ["card"] },
              { op: "remove", targets: ["card"] },
              { op: "create", targets: ["start"] },
            ],
          },
          { actions: [{ op: "create", targets: ["answer"] }] },
        ],
      }),
    );
    // 第 0 拍：题目卡建了又收走，答案还没登场——屏幕上只有起点
    expect(beats[0]!.groups.map((g) => g.id)).toEqual(["start"]);
    // 答案在它自己那一拍才出现
    expect(beats[1]!.groups.map((g) => g.id)).toEqual(["start", "answer"]);
  });

  it("spec 完全不用引入动词时，行为与从前一致（全部常驻）", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "a", primitive: "unit_grid", params: { count: 3 } },
          { id: "b", primitive: "unit_grid", params: { count: 4 } },
        ],
        scenes: [{ actions: [{ op: "highlight", targets: ["a"] }] }],
      }),
    );
    expect(beats[0]!.groups.map((g) => g.id)).toEqual(["a", "b"]);
  });

  it("一拍把东西收光了就把它放回来：宁可挤，不可白屏", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "only", primitive: "unit_grid", params: { count: 3 } }],
        scenes: [
          { actions: [{ op: "create", targets: ["only"] }] },
          { actions: [{ op: "remove", targets: ["only"] }] },
        ],
      }),
    );
    expect(beats[1]!.groups.map((g) => g.id)).toEqual(["only"]);
  });
});

describe("foldBeats: 守恒只在可通约的组之间成立", () => {
  it("不同种类的量不相加：假设法只断言被替换那一组的个体数不变", () => {
    // 鸡兔同笼的真实形态：35 个头 + 70/94 只脚 + 12 兔 + 23 鸡。
    // 若把它们全加起来，两边都是 234、永远"守恒"——那是一个把头和脚加在一起的假事实。
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "heads", primitive: "unit_grid", params: { count: 35 } },
          { id: "feet_now", primitive: "quantity_bar", params: { value: 70 } },
          { id: "feet_real", primitive: "quantity_bar", params: { value: 94 } },
          { id: "rabbits", primitive: "unit_grid", params: { count: 12 } },
        ],
        scenes: [
          {
            actions: [
              { op: "swap_units", targets: ["heads"], source: "heads", destination: "rabbits", count: 12 },
            ],
          },
        ],
      }),
    );
    // 守恒的是「头数」，不是满屏所有数字的和
    expect(beats[0]!.conservation).toEqual({ before: 35, after: 35, ok: true });
  });

  it("单位真的流动过的组之间才算总量，且跨拍记住这层关系", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "apples", primitive: "unit_grid", params: { count: 9 } },
          { id: "basket", primitive: "rectangle", params: {} },
          { id: "unrelated", primitive: "unit_grid", params: { count: 100 } },
        ],
        scenes: [
          { actions: [{ op: "take_from", source: "apples", destination: "basket", count: 4 }] },
          { actions: [{ op: "take_from", source: "apples", count: 2 }] },
        ],
      }),
    );
    // 第 1 拍：苹果和篮子并成一个分量，9 = 5 + 4
    expect(beats[0]!.conservation).toEqual({ before: 9, after: 9, ok: true });
    // 第 2 拍只动苹果，但篮子仍在同一分量里算数（第 1 拍搬过去的没消失）；
    // 与本拍无关的 unrelated 那 100 个始终不掺和进来
    expect(beats[1]!.conservation).toEqual({ before: 9, after: 9, ok: true });
  });
});
