import { describe, expect, it } from "vitest";
import { boxQuality, normalizeBox, parseJsonObjects, parseLayout, snapBoxes } from "./passes.js";

describe("normalizeBox", () => {
  it("收下 0~1 的相对框", () => {
    expect(normalizeBox([0.08, 0.12, 0.95, 0.3])).toEqual([0.08, 0.12, 0.95, 0.3]);
  });

  it("把 0~100 的百分数换算成比例", () => {
    expect(normalizeBox([8, 12, 95, 30])).toEqual([0.08, 0.12, 0.95, 0.3]);
  });

  it("左右/上下写反了也认", () => {
    expect(normalizeBox([0.95, 0.3, 0.08, 0.12])).toEqual([0.08, 0.12, 0.95, 0.3]);
  });

  it("越界的坐标夹回画布内", () => {
    expect(normalizeBox([-0.1, -0.2, 1.4, 1.5])).toBeUndefined(); // 1.4 会被当百分数，超 100 判废
    expect(normalizeBox([-0.1, -0.2, 0.9, 0.8])).toEqual([0, 0, 0.9, 0.8]);
  });

  it.each([
    ["太窄", [0.4, 0.1, 0.5, 0.5]],
    ["太扁", [0.1, 0.4, 0.9, 0.41]],
    ["字段缺失", [0.1, 0.2]],
    ["不是数组", { x: 1 }],
    ["含非数字", [0.1, "a", 0.9, 0.8]],
  ])("丢掉不可用的框：%s", (_why, raw) => {
    expect(normalizeBox(raw)).toBeUndefined();
  });

  it("像素坐标给不出比例时判废，而不是拿去裁", () => {
    // 1600x2200 的页图上模型直接给了像素——按比例理解会裁到画布外
    expect(normalizeBox([120, 300, 1500, 700])).toBeUndefined();
  });
});

describe("parseLayout", () => {
  const jsonl = [
    '{"index":1,"label":"练习1","preview":"一块木板上有若干枚钉子","box":[0.08,0.4,0.95,0.6],"hasFigure":true,"continued":false}',
    '{"index":2,"label":"练习2","preview":"小明有12个苹果","box":[0.08,0.1,0.95,0.3],"hasFigure":false,"continued":false}',
  ].join("\n");

  it("逐行解析并按纵向位置排序", () => {
    const items = parseLayout(jsonl);
    expect(items.map((i) => i.label)).toEqual(["练习2", "练习1"]);
    expect(items[1]!.hasFigure).toBe(true);
  });

  it("最后一行被截断时，前面的行照常可用", () => {
    const truncated = `${jsonl}\n{"index":3,"label":"练习3","prev`;
    expect(parseLayout(truncated)).toHaveLength(2);
  });

  it("剥掉代码围栏", () => {
    expect(parseLayout("```json\n" + jsonl + "\n```")).toHaveLength(2);
  });

  it("模型仍旧输出数组时也能收下", () => {
    const asArray = `[\n${jsonl.split("\n").join(",\n")}\n]`;
    expect(parseLayout(asArray)).toHaveLength(2);
  });

  it("框不可用时保留题目、只丢框——题不能因为定位失败而消失", () => {
    const items = parseLayout('{"index":1,"label":"练习1","preview":"小明有12个苹果","box":[9,9,9,9]}');
    expect(items).toHaveLength(1);
    expect(items[0]!.box).toBeUndefined();
  });

  it("这一页没题就返回空", () => {
    expect(parseLayout("这一页没有题目。")).toEqual([]);
  });
});

describe("snapBoxes", () => {
  const item = (y0: number, y1: number, box = true) => ({
    index: 1,
    label: "",
    preview: "题",
    ...(box ? { box: [0.08, y0, 0.92, y1] as [number, number, number, number] } : {}),
    hasFigure: false,
    continued: false,
  });

  /**
   * 实测拿到的真实框：模型框到配图为止（0.20），而【答案】灰框在 0.21~0.34。
   * 不补边界就会裁出一张没有答案的图，且不会报错。
   */
  it("把下边界推到下一道题的上边界，好把答案框收进来", () => {
    const out = snapBoxes([item(0.05, 0.2), item(0.36, 0.79)]);
    expect(out[0]!.box![3]).toBe(0.36);
  });

  it("最后一道题推到页底", () => {
    const out = snapBoxes([item(0.05, 0.2), item(0.36, 0.79)]);
    expect(out[1]!.box![3]).toBe(1);
  });

  it("模型已经框到位时保持原样，绝不上收", () => {
    const out = snapBoxes([item(0.05, 0.34), item(0.3, 0.79)]);
    expect(out[0]!.box![3]).toBe(0.34);
  });

  it("左右边界不动——只有纵向才有'答案在下面'这回事", () => {
    const out = snapBoxes([item(0.05, 0.2), item(0.36, 0.79)]);
    expect(out[0]!.box![0]).toBe(0.08);
    expect(out[0]!.box![2]).toBe(0.92);
  });

  it("中间夹着没有框的题时，跳过它去找下一个有框的", () => {
    // 没框的题位置未知，拿它当边界就是拿一个猜的数去裁图
    const out = snapBoxes([item(0.05, 0.2), item(0, 0, false), item(0.6, 0.8)]);
    expect(out[0]!.box![3]).toBe(0.6);
  });

  it("没有框的题不会凭空长出框", () => {
    expect(snapBoxes([item(0, 0, false)])[0]!.box).toBeUndefined();
  });
});

describe("boxQuality", () => {
  it("报告可用率：低到一定程度就该换模型", () => {
    const items = parseLayout(
      [
        '{"index":1,"preview":"甲","box":[0.1,0.1,0.9,0.3]}',
        '{"index":2,"preview":"乙"}',
        '{"index":3,"preview":"丙"}',
        '{"index":4,"preview":"丁"}',
      ].join("\n"),
    );
    expect(boxQuality(items)).toEqual({ total: 4, withBox: 1, ratio: 0.25 });
  });

  it("一道题都没有时不报除零", () => {
    expect(boxQuality([])).toEqual({ total: 0, withBox: 0, ratio: 0 });
  });
});

describe("parseJsonObjects", () => {
  it("跨多行的单个对象也能拼回来（配图规格常这么写）", () => {
    const raw = '{\n "points": [{"id":"A"}],\n "segments": []\n}';
    expect(parseJsonObjects(raw)).toEqual([{ points: [{ id: "A" }], segments: [] }]);
  });

  it("模型用 {} 表示画不清楚", () => {
    expect(parseJsonObjects("{}")).toEqual([{}]);
  });

  it("完全不是 JSON 时返回空而不是抛错", () => {
    expect(parseJsonObjects("这道题的图形是一个三角形。")).toEqual([]);
  });
});
