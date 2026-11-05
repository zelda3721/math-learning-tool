import { describe, expect, it } from "vitest";
import { SceneSpecSchema } from "@mathtutor/schema";
import { foldBeats } from "../src/fold.js";
import { buildChannels, cuesForBeat, intensityAt, revealOpacityAt, stateValueAt } from "../src/channels.js";

/**
 * 通道同样是纯函数：给一拍（和拍内比例），强调谁、强到什么程度都是算出来的。
 * 这条不成立，seek 到拍中间就永远画不对——而"跳到第 7.3 秒"正是阶段 2 的目的。
 */

const parse = (raw: unknown) => SceneSpecSchema.parse(raw);

const spec = parse({
  visual_objects: [
    { id: "a", primitive: "unit_grid", params: { total: 4 } },
    { id: "b", primitive: "unit_grid", params: { total: 3 } },
  ],
  scenes: [
    { actions: [{ op: "appear", target: "a" }], teaching_line: "先有 4 个" },
    { actions: [{ op: "appear", target: "b" }], teaching_line: "又来 3 个" },
    { actions: [{ op: "take_from", source: "a", destination: "b", count: 1 }] },
  ],
});

describe("通道排布", () => {
  const beats = foldBeats(spec);

  it("第一拍的对象全部按「出现」处理（否则开场是空的）", () => {
    // 同一对象可以同时有 reveal 与 annotate：一个管显现，一个管"指这里"，
    // 所以按 kind 过滤，不要假设"一个对象只有一条通道"
    const reveals = cuesForBeat(beats[0]!).filter((c) => c.kind === "reveal");
    expect(reveals.map((c) => c.target)).toEqual(["a"]);
  });

  it("新出现的对象才 reveal，已有的不重复露", () => {
    const cues = cuesForBeat(beats[1]!, beats[0]!);
    expect(cues.filter((c) => c.kind === "reveal").map((c) => c.target)).toEqual(["b"]);
  });

  it("被动作点到的组拿到 spotlight；刚露出来的不再强调（否则先压暗再亮，像闪屏）", () => {
    const cues = cuesForBeat(beats[1]!, beats[0]!);
    expect(cues.filter((c) => c.kind === "spotlight").map((c) => c.target)).not.toContain("a");
    // b 这一拍才出现：只拿到 reveal，没有额外的 spotlight
    const bSpotlights = cues.filter((c) => c.kind === "spotlight" && c.target === "b");
    expect(bSpotlights).toHaveLength(0);
    expect(cues.filter((c) => c.kind === "reveal").map((c) => c.target)).toContain("b");
  });

  it("整段：每一拍都有排布，且不与上一拍混淆", () => {
    const all = buildChannels(beats);
    expect(all).toHaveLength(beats.length);
    expect(all[0]!.length).toBeGreaterThan(0);
  });
});

describe("强度随时间变化", () => {
  const cues = [{ target: "a", kind: "spotlight" as const, from: 0.2, to: 0.8 }];

  it("区间外为 0（不在返回值里），中间最高", () => {
    expect(intensityAt(cues, 0.1).get("a")).toBeUndefined();
    expect(intensityAt(cues, 0.5).get("a")).toBeCloseTo(1, 5);
    expect(intensityAt(cues, 0.9).get("a")).toBeUndefined();
  });

  it("渐入渐出而不是阶跃（阶跃在 60fps 下就是闪）", () => {
    const rising = intensityAt(cues, 0.28).get("a")!;
    const peak = intensityAt(cues, 0.5).get("a")!;
    const falling = intensityAt(cues, 0.72).get("a")!;
    expect(rising).toBeGreaterThan(0);
    expect(rising).toBeLessThan(peak);
    expect(falling).toBeGreaterThan(0);
    expect(falling).toBeLessThan(peak);
  });

  it("纯粹：同一比例反复求值恒等；越界与 NaN 钳制", () => {
    expect(intensityAt(cues, 0.31)).toEqual(intensityAt(cues, 0.31));
    expect(intensityAt(cues, -5).size).toBe(0);
    expect(intensityAt(cues, Number.NaN).size).toBe(0);
  });
});

describe("reveal 的不透明度", () => {
  const cue = { target: "a", kind: "reveal" as const, from: 0, to: 0.5 };

  it("从 0.25 起步（停在开头不是一片空白），窗口结束后停在 1", () => {
    expect(revealOpacityAt(cue, 0)).toBeCloseTo(0.25, 5);
    expect(revealOpacityAt(cue, 0.5)).toBe(1);
    expect(revealOpacityAt(cue, 0.9)).toBe(1);
  });

  it("单向：出现之后不会回落到 0（那是出现，不是脉冲）", () => {
    const samples = [0, 0.1, 0.25, 0.5, 0.8, 1];
    const values = samples.map((p) => revealOpacityAt(cue, p));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });
});

describe("annotate：把讲解句钉到被强调的对象旁", () => {
  const beat = (teachingLine: string | undefined, emphasized: string[]) =>
    ({
      index: 1,
      teachingLine,
      groups: [
        { id: "a", emphasis: emphasized.includes("a") },
        { id: "b", emphasis: emphasized.includes("b") },
      ],
      moves: [],
      counts: [],
      declaredColors: {},
      objects: [],
    }) as unknown as Parameters<typeof cuesForBeat>[0];

  it("短句 + 有强调对象 → 贴在那个对象上", () => {
    const cues = cuesForBeat(beat("拿走 4 个", ["a"]));
    const note = cues.find((c) => c.kind === "annotate");
    expect(note?.target).toBe("a");
    expect(note?.text).toBe("拿走 4 个");
  });

  it("长句不贴：它会盖住图形，而字幕那边已经在说了", () => {
    const long = "利用共线线段上的三角形面积比等于底边比，逐步求出中间三角形的面积";
    expect(cuesForBeat(beat(long, ["a"])).some((c) => c.kind === "annotate")).toBe(false);
  });

  it("没有强调对象 / 没有讲解句 → 不贴", () => {
    expect(cuesForBeat(beat("拿走 4 个", [])).some((c) => c.kind === "annotate")).toBe(false);
    expect(cuesForBeat(beat(undefined, ["a"])).some((c) => c.kind === "annotate")).toBe(false);
  });

  it("只贴第一处：一拍点多组时，同一句话贴三处只是噪音", () => {
    const notes = cuesForBeat(beat("看这里", ["a", "b"])).filter((c) => c.kind === "annotate");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.target).toBe("a");
  });
});

describe("state：拍内的量在动（数一遍）", () => {
  it("counts 里的组拿到 state 通道，走到的是 actual 而不是 claimed", () => {
    const beat = {
      index: 2,
      teachingLine: "数一遍",
      groups: [{ id: "a", emphasis: true }],
      moves: [],
      // 宣称 99、实际只有 5：动画必须走到 5
      counts: [{ groupId: "a", claimed: 99, actual: 5 }],
      declaredColors: {},
      objects: [],
    } as unknown as Parameters<typeof cuesForBeat>[0];

    const state = cuesForBeat(beat).find((c) => c.kind === "state");
    expect(state?.target).toBe("a");
    expect(state?.toValue).toBe(5);
  });

  it("数值从 0 数到终值，窗口过后停在终值（单向，不倒回去）", () => {
    const cue = { target: "a", kind: "state" as const, from: 0.15, to: 0.85, toValue: 12 };
    expect(stateValueAt(cue, 0)).toBe(0);
    expect(stateValueAt(cue, 0.5)).toBeGreaterThan(0);
    expect(stateValueAt(cue, 0.5)).toBeLessThan(12);
    expect(stateValueAt(cue, 0.85)).toBe(12);
    expect(stateValueAt(cue, 1)).toBe(12);
  });

  it("纯粹：同一比例反复求值恒等；越界与 NaN 钳制", () => {
    const cue = { target: "a", kind: "state" as const, from: 0.15, to: 0.85, toValue: 12 };
    expect(stateValueAt(cue, 0.42)).toBe(stateValueAt(cue, 0.42));
    expect(stateValueAt(cue, -1)).toBe(0);
    expect(stateValueAt(cue, Number.NaN)).toBe(0);
  });
});
