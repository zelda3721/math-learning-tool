import { describe, expect, it } from "vitest";
import { SceneSpecSchema } from "@mathtutor/schema";
import { buildTimeline, Playhead, DEFAULT_BEAT_MS } from "../src/timeline.js";
import { foldBeats } from "../src/fold.js";
import { solveScene } from "../src/render/scene.js";
import { layoutFlowed } from "../src/render/layout.js";

/**
 * 阶段 2 的地基：**画面只能由 t 决定**。
 *
 * 逐像素一致没法在 node 里验（要浏览器），但它的根在这里：
 * 只要 (拍数, 选项) 定了，任何时刻归属哪一拍、推进了多少，都是算出来的；
 * 再加上渲染管线本身是纯函数，"同一 t 两次渲染相同"就是推论，而不是祈祷。
 */

describe("时间轴：t → 帧 是算出来的", () => {
  const tl = buildTimeline(4, { beatMs: 1000, transitionMs: 200 });

  it("总时长 = 拍数 × 每拍时长", () => {
    expect(tl.duration).toBe(4000);
    expect(tl.beatCount).toBe(4);
  });

  it("拍边界精确落在整倍数上", () => {
    for (let i = 0; i < 4; i += 1) {
      expect(tl.beatStart(i)).toBe(i * 1000);
      // 边界那一刻属于新的一拍，局部进度为 0
      expect(tl.frameAt(i * 1000)).toMatchObject({ beatIndex: i, local: 0 });
    }
  });

  it("默认参数下每拍 3200ms（与旧播放器一致，切时间轴不该改观看节奏）", () => {
    expect(buildTimeline(3).duration).toBe(3 * DEFAULT_BEAT_MS);
  });

  it("转场落在每拍末尾，不属于下一拍的开头", () => {
    // 第 1 拍 0..1000，转场窗口是 800..1000
    const inTransition = tl.frameAt(900);
    expect(inTransition.transition).toEqual({ from: 0, to: 1, progress: 0.5 });
    expect(inTransition.local).toBe(1);

    const justBefore = tl.frameAt(799);
    expect(justBefore.transition).toBeUndefined();
    expect(justBefore.beatIndex).toBe(0);
    // 转场开始前的最后一帧仍在本拍内
    expect(justBefore.local).toBeCloseTo(0.799, 6);
  });

  it("最后一拍末尾不转场到空白", () => {
    const end = tl.frameAt(tl.duration);
    expect(end).toEqual({ tMs: 4000, beatIndex: 3, local: 1 });
  });

  it("越界与脏值都钳制，不返回 NaN", () => {
    expect(tl.frameAt(-100)).toMatchObject({ tMs: 0, beatIndex: 0, local: 0 });
    expect(tl.frameAt(99_999)).toMatchObject({ tMs: 4000, beatIndex: 3, local: 1 });
    expect(tl.frameAt(Number.NaN)).toMatchObject({ tMs: 0, beatIndex: 0 });
    expect(tl.beatStart(-3)).toBe(0);
    expect(tl.beatStart(99)).toBe(3000);
  });

  it("0 拍也能用（空 spec 不该让播放器崩）", () => {
    const empty = buildTimeline(0);
    expect(empty.duration).toBe(0);
    expect(empty.frameAt(123)).toEqual({ tMs: 0, beatIndex: 0, local: 0 });
  });

  it("纯粹性：同一 t 反复求值恒等，且与求值顺序无关", () => {
    const samples = [0, 137, 800, 999, 1000, 1777, 3999, 4000];
    const first = samples.map((t) => tl.frameAt(t));
    const reversed = [...samples].reverse().map((t) => tl.frameAt(t)).reverse();
    expect(reversed).toEqual(first);
    // 再跑一遍还是同一批值
    expect(samples.map((t) => tl.frameAt(t))).toEqual(first);
  });
});

describe("渲染管线是纯函数（逐像素一致的前提）", () => {
  const spec = SceneSpecSchema.parse({
    visual_objects: [
      { id: "t1", primitive: "quantity_bar", params: { total: 12, color: "#4f46e5" } },
      { id: "t2", primitive: "quantity_bar", params: { total: 4, color: "#4f46e5" } },
    ],
    scenes: [
      { actions: [{ op: "appear", target: "t1" }], teaching_line: "12 颗糖" },
      { actions: [{ op: "partition", target: "t1", groups: ["t2"] }], teaching_line: "分给 3 个人" },
    ],
  });

  it("同一拍解两次得到相同的场景与布局", () => {
    const beats = foldBeats(spec);
    for (const beat of beats) {
      const a = solveScene(beat, 640, 380);
      const b = solveScene(beat, 640, 380);
      expect(b).toEqual(a);

      const la = layoutFlowed(a, { width: 640, height: 380, top: 16, bottom: 16 });
      const lb = layoutFlowed(b, { width: 640, height: 380, top: 16, bottom: 16 });
      expect(lb).toEqual(la);
    }
  });

  it("不同时刻落到不同拍上，画面确实不同（否则确定性就是句空话）", () => {
    const beats = foldBeats(spec);
    const tl = buildTimeline(beats.length, { beatMs: 1000, transitionMs: 0 });
    const at = (t: number) => solveScene(beats[tl.frameAt(t).beatIndex]!, 640, 380);
    expect(at(0)).not.toEqual(at(1000));
  });
});

describe("播放头：时间在走，画面跟着 t 走", () => {
  const make = () => new Playhead(buildTimeline(4, { beatMs: 1000, transitionMs: 0 }));

  it("advance 累加时间，跨拍时 beatIndex 跟着变", () => {
    const ph = make();
    expect(ph.advance(400).beatIndex).toBe(0);
    expect(ph.advance(700).beatIndex).toBe(1);
    expect(ph.time).toBe(1100);
  });

  it("走到末尾就停住，finished 为真，再 advance 也不越界", () => {
    const ph = make();
    ph.advance(10_000);
    expect(ph.time).toBe(4000);
    expect(ph.finished).toBe(true);
    expect(ph.advance(500).beatIndex).toBe(3);
    expect(ph.time).toBe(4000);
  });

  it("seek 越界钳制；seekBeat 落到拍的起点", () => {
    const ph = make();
    expect(ph.seek(-50).beatIndex).toBe(0);
    expect(ph.seek(99_999).tMs).toBe(4000);
    expect(ph.seekBeat(2).tMs).toBe(2000);
    expect(ph.seekBeat(99).tMs).toBe(3000);
  });

  it("时钟回拨/NaN 不当成负的推进（页面切后台再回来时真会发生）", () => {
    const ph = make();
    ph.seek(1500);
    expect(ph.advance(-800).tMs).toBe(1500);
    expect(ph.advance(Number.NaN).tMs).toBe(1500);
    expect(ph.time).toBe(1500);
  });
});
