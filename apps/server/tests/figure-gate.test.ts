import { describe, expect, it } from "vitest";
import { checkFigure } from "../src/ingest/figureGate.js";

const STEM = "如图，直角三角形 ABC 中，∠B = 90°，AB = 3 厘米，BC = 4 厘米。求斜边 AC 的长。";

const GOOD = {
  points: [{ id: "A" }, { id: "B" }, { id: "C" }],
  segments: [
    { from: "A", to: "B", label: "3 厘米" },
    { from: "B", to: "C", label: "4 厘米" },
    { from: "C", to: "A" },
  ],
  angles: [{ at: "B", from: "A", to: "C", right: true }],
  constraints: [
    { kind: "length", from: "A", to: "B", value: 3 },
    { kind: "length", from: "B", to: "C", value: 4 },
    { kind: "right-angle", at: "B", from: "A", to: "C" },
  ],
};

describe("配图门禁：解得出来，且数字得有出处", () => {
  it("题干里的条件写进图里 → 收下", () => {
    const r = checkFigure(GOOD, STEM);
    expect(r.figure).toBeTruthy();
    expect(r.rejected).toBeUndefined();
  });

  it("图上多写了题干没给的量 → 丢掉配图", () => {
    // 模型看图量出斜边 5 并写进约束：图自洽，但这道题本来是要孩子求 5 的。
    // 写进去等于把答案画在图上。
    const leaky = { ...GOOD, constraints: [...GOOD.constraints, { kind: "length", from: "A", to: "C", value: 5 }] };
    const r = checkFigure(leaky, STEM);
    expect(r.figure).toBeUndefined();
    expect(r.rejected).toContain("题干没有的条件");
    expect(r.rejected).toContain("AC");
  });

  it("条件自相矛盾 → 丢掉配图并说明", () => {
    const stem = "三角形三边分别是 1、2、10，求周长。";
    const bad = {
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 1 },
        { kind: "length", from: "B", to: "C", value: 2 },
        { kind: "length", from: "A", to: "C", value: 10 },
      ],
    };
    const r = checkFigure(bad, stem);
    expect(r.figure).toBeUndefined();
    expect(r.rejected).toContain("画不出来");
  });

  it("规格不合法 → 丢掉配图，不让它把整题带崩", () => {
    const r = checkFigure({ points: [{ id: "A" }] }, STEM); // 少于两个点
    expect(r.figure).toBeUndefined();
    expect(r.rejected).toContain("不合法");
  });

  it("没有图的题不受影响", () => {
    expect(checkFigure(undefined, "小明有 5 个苹果")).toEqual({});
    expect(checkFigure(null, "小明有 5 个苹果")).toEqual({});
  });

  it("直角不需要题干写出 90 也放行（普遍约定）", () => {
    const stem = "如图，∠B 是直角，AB = 3，BC = 4，求 AC。";
    const r = checkFigure(GOOD, stem);
    expect(r.figure).toBeTruthy();
  });

  it("题干给了角度时，图上的角度必须与它一致", () => {
    const stem = "三角形 ABC 中，AB = 10，AC = 7，∠A = 60°，求 BC。";
    const ok = {
      points: [{ id: "A" }, { id: "B" }, { id: "C" }],
      constraints: [
        { kind: "length", from: "A", to: "B", value: 10 },
        { kind: "length", from: "A", to: "C", value: 7 },
        { kind: "angle", at: "A", from: "B", to: "C", degrees: 60 },
      ],
    };
    expect(checkFigure(ok, stem).figure).toBeTruthy();
    // 把 60 抄成 65：题干里没有 65
    const wrong = { ...ok, constraints: [...ok.constraints.slice(0, 2), { kind: "angle", at: "A", from: "B", to: "C", degrees: 65 }] };
    expect(checkFigure(wrong, stem).rejected).toContain("题干没有的条件");
  });
})

describe("入库这一刻的最后一道关", () => {
  it("确认入库时若配图被改坏，去掉配图但保留题目", async () => {
    const { createApp } = await import("../src/app.js");
    const { makeQuestion, tempFixtureEnv, NODE_A } = await import("./helpers.js");
    const env = tempFixtureEnv([makeQuestion({ id: "x1", nodeIds: [NODE_A] })]);
    const app = createApp(env.state);

    const res = await app.request("/api/v1/ingest/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batchName: "figure-test",
        questions: [{
          stem: "如图，直角三角形 ABC 中，∠B = 90°，AB = 3，BC = 4，求 AC。",
          answer: "5",
          answerType: "numeric",
          difficulty: 2,
          level: "middle",
          nodeIds: [NODE_A],
          // 前端把答案 5 塞进了图里——这一关必须拦住
          figure: {
            points: [{ id: "A" }, { id: "B" }, { id: "C" }],
            constraints: [
              { kind: "length", from: "A", to: "B", value: 3 },
              { kind: "length", from: "B", to: "C", value: 4 },
              { kind: "length", from: "A", to: "C", value: 5 },
            ],
          },
        }],
      }),
    });
    const body = (await res.json()) as { written: number; issues: { problem: string }[] };
    // 题目照常入库，只是没有配图
    expect(body.written).toBe(1);
    expect(body.issues.some((i) => i.problem.includes("题干没有的条件"))).toBe(true);
    const stored = env.state.questions.all.find((q) => q.stem.includes("直角三角形 ABC"));
    expect(stored).toBeTruthy();
    expect(stored!.figure).toBeUndefined();
  });

  it("合规的配图确实存进了题库", async () => {
    const { createApp } = await import("../src/app.js");
    const { makeQuestion, tempFixtureEnv, NODE_A } = await import("./helpers.js");
    const env = tempFixtureEnv([makeQuestion({ id: "x2", nodeIds: [NODE_A] })]);
    const app = createApp(env.state);
    await app.request("/api/v1/ingest/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batchName: "figure-ok",
        questions: [{
          stem: "如图，∠B 是直角，AB = 3，BC = 4，求 AC。",
          answer: "5", answerType: "numeric", difficulty: 2, level: "middle", nodeIds: [NODE_A],
          figure: {
            points: [{ id: "A" }, { id: "B" }, { id: "C" }],
            constraints: [
              { kind: "length", from: "A", to: "B", value: 3 },
              { kind: "length", from: "B", to: "C", value: 4 },
              { kind: "right-angle", at: "B", from: "A", to: "C" },
            ],
          },
        }],
      }),
    });
    const stored = env.state.questions.all.find((q) => q.stem.includes("∠B 是直角"));
    expect(stored?.figure).toBeTruthy();
    expect(stored!.figure!.constraints).toHaveLength(3);
  });
})

describe("模型写法不规范时先归一，别为格式小事丢掉好图", () => {
  const stem = "如图，∠B 是直角，AB = 3，BC = 4，求 AC。";
  const constraints = [
    { kind: "length", from: "A", to: "B", value: 3 },
    { kind: "length", from: "B", to: "C", value: 4 },
    { kind: "right-angle", at: "B", from: "A", to: "C" },
  ];

  it("points 写成字符串数组也认", () => {
    const r = checkFigure({ points: ["A", "B", "C"], constraints }, stem);
    expect(r.figure?.points.map((p) => p.id)).toEqual(["A", "B", "C"]);
  });

  it("顶点用 name / label 代替 id 也认", () => {
    const r = checkFigure({ points: [{ name: "A" }, { label: "B" }, { id: "C" }], constraints }, stem);
    expect(r.figure?.points.map((p) => p.id)).toEqual(["A", "B", "C"]);
  });

  it("segments 写成 [a,b] 或 {start,end} 也认", () => {
    const r = checkFigure(
      { points: ["A", "B", "C"], segments: [["A", "B"], { start: "B", end: "C" }], constraints },
      stem,
    );
    expect(r.figure?.segments.map((s) => `${s.from}${s.to}`)).toEqual(["AB", "BC"]);
  });

  it("真的不合法时要说清楚是哪个字段——只说 Required 谁也查不出来", () => {
    const r = checkFigure({ segments: [] }, stem); // 没有 points
    expect(r.rejected).toContain("points");
    expect(r.rejected).not.toBe("配图规格不合法：Required");
  });
})

describe("约束的写法也要归一（实机报的是 constraints.0.from Required）", () => {
  const stem = "如图，∠B 是直角，AB = 3，BC = 4，求 AC。";
  const points = ["A", "B", "C"];

  it("长度写成 points 数组", () => {
    const r = checkFigure({ points, constraints: [
      { kind: "length", points: ["A", "B"], value: 3 },
      { kind: "length", points: ["B", "C"], value: 4 },
      { kind: "right-angle", at: "B", from: "A", to: "C" },
    ] }, stem);
    expect(r.rejected).toBeUndefined();
    expect(r.figure!.constraints).toHaveLength(3);
  });

  it("长度写成 segment:\"AB\"", () => {
    const r = checkFigure({ points, constraints: [
      { kind: "length", segment: "AB", value: 3 },
      { kind: "length", segment: "BC", value: 4 },
      { kind: "right-angle", vertex: "B", from: "A", to: "C" },
    ] }, stem);
    expect(r.rejected).toBeUndefined();
  });

  it("角写成三点数组，中间那个是顶点", () => {
    const s2 = "三角形 ABC 中，AB = 10，AC = 7，∠A = 60°，求 BC。";
    const r = checkFigure({ points, constraints: [
      { kind: "length", from: "A", to: "B", value: 10 },
      { kind: "length", from: "A", to: "C", value: 7 },
      { kind: "angle", points: ["B", "A", "C"], degrees: 60 },
    ] }, s2);
    expect(r.rejected).toBeUndefined();
  });

  it("直角写成 angle + degrees:90 也认（题干不必出现 90）", () => {
    const r = checkFigure({ points, constraints: [
      { kind: "length", from: "A", to: "B", value: 3 },
      { kind: "length", from: "B", to: "C", value: 4 },
      { kind: "angle", at: "B", from: "A", to: "C", degrees: 90 },
    ] }, stem);
    expect(r.rejected).toBeUndefined();
  });

  it("归一只改写法，不改内容：编出来的条件照样被拒", () => {
    const r = checkFigure({ points, constraints: [
      { kind: "length", segment: "AB", value: 3 },
      { kind: "length", segment: "AC", value: 5 },  // 题干没给，等于把答案画上去
    ] }, stem);
    expect(r.rejected).toContain("题干没有的条件");
  });
})
