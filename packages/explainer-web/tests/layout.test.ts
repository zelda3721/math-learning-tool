import { describe, expect, it } from "vitest";
import { SceneSpecSchema } from "@mathtutor/schema";
import { foldBeats } from "../src/fold.js";
import {
  limitSwaps,
  liveTotal,
  solveScene,
  swappedCount,
  unitTotals,
  withLiveBar,
} from "../src/render/scene.js";
import { columnsFor, layoutFlowed, type Placed, type PlacedBar, type PlacedUnits } from "../src/render/layout.js";

const W = 900;
const H = 520;
const OPTS = { width: W, height: H, top: 40, bottom: 56 };

const parse = (raw: unknown) => SceneSpecSchema.parse(raw);
const bars = (items: Placed[]): PlacedBar[] => items.filter((i): i is PlacedBar => i.kind === "bar");
const units = (items: Placed[]): PlacedUnits[] =>
  items.filter((i): i is PlacedUnits => i.kind === "units");

/** 一拍从 spec 到坐标的完整链路（折叠 → 解算 → 布局） */
function layoutBeat(spec: unknown, index = 0) {
  const beats = foldBeats(parse(spec));
  const scene = solveScene(beats[index]!, W, H);
  return { scene, layout: layoutFlowed(scene, OPTS) };
}

describe("布局规则 2/4：量画成条，共享一把尺，差额看得见", () => {
  const spec = {
    visual_objects: [
      { id: "now", primitive: "quantity_bar", params: { value: 70 }, label: "70只脚", color: "blue" },
      { id: "real", primitive: "quantity_bar", params: { value: 94 }, label: "94只脚", color: "orange" },
    ],
    scenes: [{ actions: [] }],
  };

  it("两根条左边缘对齐、槽宽相同——比较才有意义", () => {
    const { layout } = layoutBeat(spec);
    const [a, b] = bars(layout.items);
    expect(bars(layout.items)).toHaveLength(2);
    expect(a!.box.x).toBe(b!.box.x);
    expect(a!.box.w).toBe(b!.box.w);
  });

  it("填充长度正比于数值：70/94 的长度比就是 70/94", () => {
    const { layout } = layoutBeat(spec);
    const [a, b] = bars(layout.items);
    expect(b!.fillW / a!.fillW).toBeCloseTo(94 / 70, 6);
    // 最大的那根填满整个槽，尺子才用得满
    expect(b!.fillW).toBeCloseTo(b!.box.w, 6);
  });

  it("长的那根标出比短的多出来的一截，差值就是 24", () => {
    const { layout } = layoutBeat(spec);
    const [short, long] = bars(layout.items);
    expect(short!.delta).toBeUndefined();
    expect(long!.delta?.value).toBe(24);
    // 高亮段正是从短条末端到长条末端
    expect(long!.delta!.fromX).toBeCloseTo(short!.fillW, 6);
    expect(long!.delta!.toX).toBeCloseTo(long!.fillW, 6);
  });

  it("条不摊成散点：94 的量不产生 94 个记号", () => {
    const { scene, layout } = layoutBeat(spec);
    expect(scene.flowed.every((s) => s.kind !== "units")).toBe(true);
    expect(units(layout.items)).toHaveLength(0);
  });
});

describe("布局规则 1/3：语义标记与知觉分块", () => {
  it("不同组拿到不同的配色通道；spec 给了色名就按色名分", () => {
    const { layout } = layoutBeat({
      visual_objects: [
        { id: "rabbit", primitive: "unit_grid", params: { count: 12 }, color: "red" },
        { id: "chicken", primitive: "unit_grid", params: { count: 23 }, color: "yellow" },
      ],
      scenes: [{ actions: [] }],
    });
    const [a, b] = units(layout.items);
    expect(a!.channel).not.toBe(b!.channel);
  });

  it("列数听 spec 的 columns：35 个按 7 列排成 5 行", () => {
    const { layout } = layoutBeat({
      visual_objects: [
        { id: "g", primitive: "unit_grid", params: { count: 35, columns: 7 }, label: "35只动物" },
      ],
      scenes: [{ actions: [] }],
    });
    const g = units(layout.items)[0]!;
    const rows = new Set(g.units.map((u) => Math.round(u.cy)));
    const cols = new Set(g.units.map((u) => Math.round(u.cx)));
    expect(cols.size).toBe(7);
    expect(rows.size).toBe(5);
  });

  it("每 5 个之间留出更大的缝，数得出来而不用一个个点", () => {
    const { layout } = layoutBeat({
      visual_objects: [{ id: "g", primitive: "unit_grid", params: { count: 10, columns: 10 } }],
      scenes: [{ actions: [] }],
    });
    const row = units(layout.items)[0]!.units;
    const gaps: number[] = [];
    for (let i = 1; i < row.length; i += 1) gaps.push(row[i]!.cx - row[i - 1]!.cx);
    // 第 5 与第 6 个之间的间距明显大于块内间距
    const withinChunk = gaps[0]!;
    const acrossChunk = gaps[4]!;
    expect(acrossChunk).toBeGreaterThan(withinChunk);
  });

  it("columnsFor：没声明时接近正方，且不超过可用列数", () => {
    expect(columnsFor(16, undefined, 99)).toBe(4);
    expect(columnsFor(35, 7, 99)).toBe(7);
    expect(columnsFor(35, 7, 3)).toBe(3);
    expect(columnsFor(0, 5, 9)).toBe(1);
  });
});

describe("布局规则 5/6：先量后分，不重叠、不溢出", () => {
  const crowded = {
    visual_objects: [
      { id: "a", primitive: "unit_grid", params: { count: 35, columns: 7 }, label: "35只动物", color: "yellow" },
      { id: "b", primitive: "unit_grid", params: { count: 23, columns: 5 }, label: "23只鸡", color: "yellow" },
      { id: "c", primitive: "unit_grid", params: { count: 12, columns: 4 }, label: "12只兔", color: "red" },
    ],
    scenes: [{ actions: [] }],
  };

  it("所有记号都落在画布内，且不侵占顶部教学句与底部事实条", () => {
    const { layout } = layoutBeat(crowded);
    for (const g of units(layout.items)) {
      for (const u of g.units) {
        expect(u.cx - u.r).toBeGreaterThanOrEqual(0);
        expect(u.cx + u.r).toBeLessThanOrEqual(W);
        expect(u.cy - u.r).toBeGreaterThanOrEqual(OPTS.top);
        expect(u.cy + u.r).toBeLessThanOrEqual(H - OPTS.bottom);
      }
    }
  });

  it("标签有自己的行：内容一律从标签下方开始，不压字", () => {
    const { layout } = layoutBeat(crowded);
    for (const g of units(layout.items)) {
      const topMost = Math.min(...g.units.map((u) => u.cy - u.r));
      expect(topMost).toBeGreaterThan(g.labelAt.y);
    }
  });

  it("组与组的方框互不重叠", () => {
    const { layout } = layoutBeat(crowded);
    const boxes = units(layout.items).map((g) => g.box);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
  });

  it("量特别大时缩小记号也要放得下，而不是画出去", () => {
    const { layout } = layoutBeat({
      visual_objects: [{ id: "big", primitive: "unit_grid", params: { count: 180 } }],
      scenes: [{ actions: [] }],
    });
    const g = units(layout.items)[0]!;
    expect(g.units).toHaveLength(180);
    expect(Math.max(...g.units.map((u) => u.cy + u.r))).toBeLessThanOrEqual(H - OPTS.bottom);
  });
});

describe("端到端：真实鸡兔同笼 spec 的三拍", () => {
  const spec = {
    visual_objects: [
      { id: "question_card", primitive: "rectangle", params: { width: 5, height: 2 }, label: "鸡兔同笼：头35，脚94", color: "white" },
      { id: "animal_grid", primitive: "unit_grid", params: { count: 35, columns: 7, rows: 5 }, label: "35只动物", color: "yellow" },
      { id: "foot_baseline", primitive: "quantity_bar", params: { value: 70 }, label: "70只脚", color: "blue" },
      { id: "foot_target", primitive: "quantity_bar", params: { value: 94 }, label: "94只脚", color: "orange" },
      { id: "gap_indicator", primitive: "rectangle", params: { width: 2.4, height: 0.5 }, label: "差24只脚", color: "red" },
      { id: "rabbit_group", primitive: "unit_grid", params: { count: 12, columns: 4 }, label: "12只兔", color: "red" },
      { id: "chicken_group", primitive: "unit_grid", params: { count: 23, columns: 5 }, label: "23只鸡", color: "yellow" },
    ],
    scenes: [
      {
        role: "setup",
        teaching_line: "假设全是鸡，35个头对应70只脚，但实际有94只脚。",
        actions: [
          { op: "create", targets: ["question_card"] },
          { op: "remove", targets: ["question_card"] },
          { op: "create", targets: ["animal_grid"] },
          { op: "create", targets: ["foot_baseline"] },
          { op: "create", targets: ["foot_target"] },
        ],
      },
      {
        role: "transform",
        teaching_line: "每把一只鸡换成兔，脚数增加2。缺口24只脚，需要换12次。",
        actions: [
          { op: "create", targets: ["gap_indicator"] },
          { op: "swap_units", targets: ["animal_grid"], source: "animal_grid", destination: "rabbit_group", count: 12 },
        ],
      },
      {
        role: "verify",
        teaching_line: "12只兔，23只鸡。头35，脚94。答案成立。",
        actions: [
          { op: "create", targets: ["chicken_group"] },
          { op: "create", targets: ["rabbit_group"] },
          { op: "recount_verify", targets: ["rabbit_group", "chicken_group"], parts: [12, 23], expect_total: 35 },
        ],
      },
    ],
  };

  it("第 0 拍不剧透答案：题卡收走了，兔和鸡还没登场", () => {
    const beats = foldBeats(parse(spec));
    expect(beats[0]!.groups.map((g) => g.id)).toEqual([
      "animal_grid",
      "foot_baseline",
      "foot_target",
    ]);
  });

  it("第 0 拍：35 个头是可数的点，70 与 94 是两根可比长短的条", () => {
    const { layout } = layoutBeat(spec, 0);
    expect(units(layout.items)).toHaveLength(1);
    expect(units(layout.items)[0]!.units).toHaveLength(35);
    const bs = bars(layout.items);
    expect(bs.map((b) => b.value)).toEqual([70, 94]);
    expect(bs[1]!.delta?.value).toBe(24);
  });

  it("第 1 拍：12 个被换过的记号可辨认，守恒说的是头数 35 不变", () => {
    const beats = foldBeats(parse(spec));
    const { layout } = { layout: layoutFlowed(solveScene(beats[1]!, W, H), OPTS) };
    const swapped = units(layout.items)
      .flatMap((g) => g.units)
      .filter((u) => u.swapped);
    expect(swapped).toHaveLength(12);
    expect(beats[1]!.conservation).toEqual({ before: 35, after: 35, ok: true });
  });

  it("第 2 拍：答案登场，计数自洽，全部内容仍在画布内", () => {
    const beats = foldBeats(parse(spec));
    const beat = beats[2]!;
    expect(beat.groups.map((g) => g.id)).toContain("rabbit_group");
    expect(beat.counts).toEqual([
      { groupId: "rabbit_group", claimed: 12, actual: 12 },
      { groupId: "chicken_group", claimed: 23, actual: 23 },
    ]);
    const layout = layoutFlowed(solveScene(beat, W, H), OPTS);
    for (const g of units(layout.items)) {
      for (const u of g.units) {
        expect(u.cx + u.r).toBeLessThanOrEqual(W);
        expect(u.cy + u.r).toBeLessThanOrEqual(H - OPTS.bottom);
      }
    }
  });
});

describe("换成什么就长成什么样（假设法的类别变化必须可追溯）", () => {
  it("被换掉的记号取目标组的通道，而不是随手换个颜色", () => {
    const spec = {
      visual_objects: [
        { id: "animals", primitive: "unit_grid", params: { count: 5 }, color: "yellow" },
        // 目标组声明为绿色，且这一拍还没登场——正因为它没登场，
        // 被换掉的那些记号才是观众唯一能看到的"它"
        { id: "rabbits", primitive: "unit_grid", params: { count: 2 }, color: "green" },
      ],
      scenes: [
        {
          actions: [
            { op: "create", targets: ["animals"] },
            { op: "swap_units", targets: ["animals"], source: "animals", destination: "rabbits", count: 2 },
          ],
        },
        { actions: [{ op: "create", targets: ["rabbits"] }] },
      ],
    };
    const beats = foldBeats(parse(spec));
    expect(beats[0]!.groups.map((g) => g.id)).toEqual(["animals"]);
    const layout = layoutFlowed(solveScene(beats[0]!, W, H), OPTS);
    const swapped = units(layout.items).flatMap((g) => g.units).filter((u) => u.swapped);
    expect(swapped).toHaveLength(2);
    // green 在通道表里是 3；源组 yellow 是 1，绝不能只是 1+1
    for (const u of swapped) expect(u.swappedChannel).toBe(3);
  });

  it("spec 没说变成什么时退到相邻通道，至少和原类别分得开", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [{ id: "g", primitive: "unit_grid", params: { count: 4 }, color: "blue" }],
        scenes: [{ actions: [{ op: "swap_units", source: "g", count: 2 }] }],
      }),
    );
    const layout = layoutFlowed(solveScene(beats[0]!, W, H), OPTS);
    const swapped = units(layout.items).flatMap((g) => g.units).filter((u) => u.swapped);
    expect(swapped).toHaveLength(2);
    for (const u of swapped) expect(u.swappedChannel).toBeUndefined();
  });
});

describe("从属即结构：count_per_unit 挂在宿主身上，不是另一堆东西", () => {
  /** 引擎确定性构造器 build_mix_swap_visual_plan 的真实产物形态 */
  const mixSwap = {
    visual_objects: [
      { id: "mix_units", primitive: "circle", label: "35 个", color: "blue", params: { count: 35, columns: 6 } },
      { id: "mix_marks", primitive: "line", color: "blue", params: { count_per_unit: 2 } },
    ],
    scenes: [
      {
        teaching_line: "每个圆圈是一个个体，下面垂 2 根线；先假设全部相同：35 × 2 = 70。",
        actions: [
          { op: "create", targets: ["mix_units"] },
          { op: "create", targets: ["mix_marks"] },
        ],
      },
      {
        teaching_line: "实际总量是 94，差 24；每换一个补 2，要换 12 个。",
        actions: [
          { op: "swap_units", targets: ["mix_units"], source: "mix_units", count: 12, expect: 4, expect_total: 94 },
        ],
      },
    ],
  };

  it("附属组不自成一堆，而是变成宿主单位身上的记号", () => {
    const beats = foldBeats(parse(mixSwap));
    const scene = solveScene(beats[0]!, W, H);
    // 屏幕上只有宿主这一组，没有第二堆散点
    expect(scene.flowed.filter((s) => s.kind === "units")).toHaveLength(1);
    const layout = layoutFlowed(scene, OPTS);
    expect(units(layout.items)).toHaveLength(1);
  });

  it("记号数 = 单位数 × 每单位数，且每个都锚在自己宿主附近", () => {
    const beats = foldBeats(parse(mixSwap));
    const layout = layoutFlowed(solveScene(beats[0]!, W, H), OPTS);
    const host = units(layout.items)[0]!;
    const total = host.units.reduce((s, u) => s + (u.markXs?.length ?? 0), 0);
    expect(total).toBe(35 * 2);
    // 锚定：记号的横向偏移不超过一个单位直径，纵向紧贴单位下沿
    for (const u of host.units) {
      expect(u.markXs).toHaveLength(2);
      for (const dx of u.markXs!) expect(Math.abs(dx)).toBeLessThanOrEqual(u.r * 2);
      expect(u.markLen).toBeGreaterThan(0);
    }
  });

  it("换了类别的单位记号数跟着变：12 × 4 + 23 × 2 = 94，能一根根数出来", () => {
    const beats = foldBeats(parse(mixSwap));
    const layout = layoutFlowed(solveScene(beats[1]!, W, H), OPTS);
    const all = units(layout.items).flatMap((g) => g.units);
    const swapped = all.filter((u) => u.swapped);
    expect(swapped).toHaveLength(12);
    for (const u of swapped) expect(u.markXs).toHaveLength(4);
    for (const u of all.filter((u) => !u.swapped)) expect(u.markXs).toHaveLength(2);
    expect(all.reduce((s, u) => s + (u.markXs?.length ?? 0), 0)).toBe(94);
    // 个体数没变——守恒说的是头，不是腿
    expect(beats[1]!.conservation).toEqual({ before: 35, after: 35, ok: true });
  });

  it("宿主 = 在场单位最多的那一组（与引擎 Manim 通道同一条规则）", () => {
    const beats = foldBeats(
      parse({
        visual_objects: [
          { id: "few", primitive: "circle", params: { count: 3 } },
          { id: "many", primitive: "circle", params: { count: 9 } },
          { id: "marks", primitive: "line", params: { count_per_unit: 2 } },
        ],
        scenes: [{ actions: [] }],
      }),
    );
    const layout = layoutFlowed(solveScene(beats[0]!, W, H), OPTS);
    const byId = new Map(units(layout.items).map((g) => [g.id, g]));
    expect(byId.get("many")!.units.every((u) => u.markXs?.length === 2)).toBe(true);
    expect(byId.get("few")!.units.every((u) => u.markXs === undefined)).toBe(true);
  });

  it("有腿的行要留出垂下的高度，腿不许插进下一行", () => {
    const beats = foldBeats(parse(mixSwap));
    const layout = layoutFlowed(solveScene(beats[0]!, W, H), OPTS);
    const host = units(layout.items)[0]!;
    const rows = new Map<number, typeof host.units>();
    for (const u of host.units) {
      const key = Math.round(u.cy);
      rows.set(key, [...(rows.get(key) ?? []), u]);
    }
    const ys = [...rows.keys()].sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i += 1) {
      const above = rows.get(ys[i - 1]!)![0]!;
      const legBottom = above.cy + above.r * 0.8 + (above.markLen ?? 0);
      const belowTop = ys[i]! - above.r;
      expect(legBottom).toBeLessThanOrEqual(belowTop);
    }
  });
});

describe("可拨动的假设：换了几只 → 头不变、脚跟着变", () => {
  const mixSwap = {
    visual_objects: [
      { id: "mix_units", primitive: "circle", label: "35 个", color: "blue", params: { count: 35, columns: 6 } },
      { id: "mix_marks", primitive: "line", color: "blue", params: { count_per_unit: 2 } },
    ],
    scenes: [
      { teaching_line: "先假设全是鸡", actions: [{ op: "create", targets: ["mix_units"] }, { op: "create", targets: ["mix_marks"] }] },
      {
        teaching_line: "每换一只补 2",
        actions: [{ op: "swap_units", targets: ["mix_units"], source: "mix_units", count: 12, expect: 4 }],
      },
    ],
  }

  const sceneAt = (index: number) => solveScene(foldBeats(parse(mixSwap))[index]!, W, H)

  it("替换那一拍认得出可回放的步数", () => {
    expect(swappedCount(sceneAt(0))).toBe(0)
    expect(swappedCount(sceneAt(1))).toBe(12)
  })

  it("拨到 k 时只有前 k 只被换过，其余退回原样", () => {
    const partial = limitSwaps(sceneAt(1), 5)
    const units = partial.flowed.flatMap((s) => (s.kind === "units" ? s.units : []))
    expect(units.filter((u) => u.swapped)).toHaveLength(5)
    // 退回去的那些记号数也要跟着退，否则脚数会虚高
    for (const u of units.filter((u) => !u.swapped)) expect(u.marks).toBeUndefined()
  })

  it("头数纹丝不动，脚数每换一只多 2——整道题的道理就在这条线上", () => {
    const beat = sceneAt(1)
    const readings = [0, 1, 5, 12].map((k) => unitTotals(limitSwaps(beat, k)))
    // 个体数（头）恒为 35
    expect(readings.map((r) => r.units)).toEqual([35, 35, 35, 35])
    // 记号数（脚）：70 起步，每换一只 +2，换满 12 只正好 94
    expect(readings.map((r) => r.marks)).toEqual([70, 72, 80, 94])
  })

  it("拨到 0 与拨满分别等于假设态与终态", () => {
    const beat = sceneAt(1)
    expect(unitTotals(limitSwaps(beat, 0)).marks).toBe(unitTotals(sceneAt(0)).marks)
    expect(unitTotals(limitSwaps(beat, 99)).marks).toBe(unitTotals(beat).marks)
  })

  it("不改原 scene（播放器每帧都要调）", () => {
    const beat = sceneAt(1)
    const before = swappedCount(beat)
    limitSwaps(beat, 3)
    expect(swappedCount(beat)).toBe(before)
  })
})

describe("拨动时依赖的量要跟着动，且不许编数", () => {
  /** 引擎确定性构造器：每个单位都挂着记号，脚数可以逐根数出来 */
  const withMarks = {
    visual_objects: [
      { id: "u", primitive: "circle", params: { count: 35, columns: 6 } },
      { id: "m", primitive: "line", params: { count_per_unit: 2 } },
    ],
    scenes: [
      { actions: [{ op: "create", targets: ["u"] }, { op: "create", targets: ["m"] }] },
      { actions: [{ op: "swap_units", source: "u", count: 12, expect: 4, expect_total: 94 }] },
    ],
  }

  /** LLM 导演：没有从属声明，脚是两根独立的条 */
  const withBars = {
    visual_objects: [
      { id: "u", primitive: "unit_grid", params: { count: 35, columns: 7 } },
      { id: "b0", primitive: "quantity_bar", params: { value: 70 }, label: "70只脚" },
      { id: "b1", primitive: "quantity_bar", params: { value: 94 }, label: "94只脚" },
    ],
    scenes: [
      { actions: [{ op: "create", targets: ["u"] }, { op: "create", targets: ["b0"] }, { op: "create", targets: ["b1"] }] },
      { actions: [{ op: "swap_units", source: "u", count: 12, expect: 4, expect_total: 94 }] },
    ],
  }

  const at = (spec: unknown, i: number) => solveScene(foldBeats(parse(spec))[i]!, W, H)

  it("记号说不清时绝不给一个凑出来的总数", () => {
    // 这份计划没有从属声明，只有被替换的 12 只带 expect=4。
    // 早先用 `?? 0` 兜底，于是画面上出现了 12×4=48——一个把 23 只鸡的腿漏掉的假数。
    const scene = at(withBars, 1)
    expect(unitTotals(scene).marks).toBeUndefined()
    expect(unitTotals(scene).units).toBe(35)
  })

  it("每个单位都挂着记号时，总数逐根数得出来", () => {
    const scene = at(withMarks, 1)
    expect(unitTotals(limitSwaps(scene, 0)).marks).toBe(70)
    expect(unitTotals(limitSwaps(scene, 12)).marks).toBe(94)
  })

  it("数不出来时按声明的 expect_total 从画面已有的量线性推进", () => {
    const scene = at(withBars, 1)
    const read = (k: number) => liveTotal(scene, k)!
    expect(read(0).value).toBe(70) // 起点取画面上比目标小的那根条
    expect(read(6).value).toBe(82)
    expect(read(12).value).toBe(94)
    expect(read(12).to).toBe(94)
  })

  it("没有替换的那一拍不谈「现在」", () => {
    expect(liveTotal(at(withBars, 0), 0)).toBeUndefined()
  })

  it("既数不出记号又没声明目标时宁可不画", () => {
    const bare = {
      visual_objects: [{ id: "u", primitive: "unit_grid", params: { count: 10 } }],
      scenes: [
        { actions: [{ op: "create", targets: ["u"] }] },
        { actions: [{ op: "swap_units", source: "u", count: 4 }] },
      ],
    }
    expect(liveTotal(at(bare, 1), 2)).toBeUndefined()
  })

  it("「现在」那根条与其它条共用同一把尺", () => {
    const scene = at(withBars, 1)
    const live = liveTotal(scene, 6)!
    const layout = layoutFlowed(withLiveBar(scene, live, "现在"), OPTS)
    const values = bars(layout.items).map((b) => b.value)
    expect(values).toContain(82)
    const byValue = new Map(bars(layout.items).map((b) => [b.value, b]))
    // 82 / 94 的长度比必须就是 82∶94，否则"追平"这件事看着就是假的
    expect(byValue.get(82)!.fillW / byValue.get(94)!.fillW).toBeCloseTo(82 / 94, 6)
  })
})

describe("内容再多也不许压到底部事实条上", () => {
  it("三根条 + 矩形 + 35 个记号同屏时，记号仍在预留区之上", () => {
    const crowded = {
      visual_objects: [
        { id: "b0", primitive: "quantity_bar", params: { value: 70 } },
        { id: "b1", primitive: "quantity_bar", params: { value: 94 } },
        { id: "b2", primitive: "quantity_bar", params: { value: 82 } },
        { id: "gap", primitive: "rectangle", params: { width: 2.4, height: 0.5 }, label: "差24" },
        { id: "u", primitive: "unit_grid", params: { count: 35, columns: 7 } },
      ],
      scenes: [{ actions: [] }],
    }
    // 画布不够高时应当缩小记号，而不是把它们画进事实条里
    const layout = layoutFlowed(solveScene(foldBeats(parse(crowded))[0]!, W, 560), {
      width: W,
      height: 560,
      top: 34,
      bottom: 88,
    })
    for (const g of units(layout.items)) {
      for (const u of g.units) {
        expect(u.cy + u.r).toBeLessThanOrEqual(560 - 88)
      }
    }
  })
})
