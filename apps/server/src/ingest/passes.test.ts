import { describe, expect, it } from "vitest";
import { boxQuality, classifyFigures, isDanglingLabel, normalizeBox, parseFirstObject, parseJsonObjects, parseLayout, repairJsonEscapes, snapBoxes, type LayoutItem } from "./passes.js";

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

describe("parseFirstObject", () => {
  /**
   * 实机上坏在这里：配图规格是多行展开的，里面 `{"id": "A"},` 自己
   * 就是一行合法 JSON。按行扫先抓到它，整张图就变成了一个点，
   * 于是报出一句谁也看不懂的「配图规格不合法：points Required」。
   */
  const PRETTY = [
    "```json",
    "{",
    '  "points": [',
    '    {"id": "A"},',
    '    {"id": "B"},',
    '    {"id": "C"}',
    "  ],",
    '  "segments": [',
    '    {"from": "A", "to": "B", "label": "3 厘米"}',
    "  ],",
    '  "constraints": [',
    '    {"kind": "length", "from": "A", "to": "B", "value": 3}',
    "  ]",
    "}",
    "```",
  ].join("\n");

  it("取的是最外层那个对象，而不是里面第一个点", () => {
    const out = parseFirstObject(PRETTY) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["points", "segments", "constraints"]);
    expect(out.points).toHaveLength(3);
  });

  it("压成一行的写法同样取到整个对象", () => {
    expect(parseFirstObject('{"points":[{"id":"A"},{"id":"B"}]}')).toEqual({
      points: [{ id: "A" }, { id: "B" }],
    });
  });

  it("被截断时当作没有图——半张图比没有图坏", () => {
    const truncated = PRETTY.slice(0, PRETTY.indexOf('"segments"'));
    expect(parseFirstObject(truncated)).toBeUndefined();
  });

  it("字符串里的花括号不会把配对搞乱", () => {
    expect(parseFirstObject('{"note":"图中 {阴影} 部分为所求","points":[]}')).toEqual({
      note: "图中 {阴影} 部分为所求",
      points: [],
    });
  });

  it("模型用 {} 表示画不清楚", () => {
    expect(parseFirstObject("{}")).toEqual({});
  });

  it("完全没有 JSON 时返回 undefined", () => {
    expect(parseFirstObject("这道题的图形太复杂了，我画不出来。")).toBeUndefined();
  });
});

describe("classifyFigures", () => {
  /**
   * 教师版一页的真实排布：题干在上、配图挨着题干，然后是【答案】【解析】灰框，
   * 解析里常另有一张老师画的解法图（割补怎么割、阴影怎么挪）。
   *
   * 扫过用户手上 20 份教师版，64 页的解析框里有图——不是边角情况。
   * 而那张图往往就是解法本身：「所求阴影部分面积等于下图中阴影部分面积」，
   * 图一给出来这道题就没了。
   */
  const item = (over: Partial<LayoutItem> = {}): LayoutItem => ({
    index: 1,
    label: "练习10",
    preview: "两个相同的直角梯形重叠",
    hasFigure: true,
    continued: false,
    box: [0.08, 0.46, 0.92, 0.94],
    ...over,
  });

  // 实测（第10讲 p5 练习10）：题干图 0.52~0.66、灰框从 0.72 起、解法图 0.76~0.88
  const STEM: [number, number, number, number] = [0.72, 0.52, 0.92, 0.66];
  const ANALYSIS: [number, number, number, number] = [0.12, 0.76, 0.28, 0.88];

  it("按灰框上边缘分：上面的是题干图，下面的是解法图", () => {
    const out = classifyFigures(
      item({ figureBox: STEM, analysisFigureBox: ANALYSIS, answerTop: 0.72 }),
    );
    expect(out.stemFigureBox).toEqual(STEM);
    expect(out.analysisFigureBox).toEqual(ANALYSIS);
  });

  it("模型把解法图标成了题干图 → 按位置纠正，孩子看不到它", () => {
    const out = classifyFigures(item({ figureBox: ANALYSIS, answerTop: 0.72 }));
    expect(out.stemFigureBox).toBeUndefined();
    expect(out.analysisFigureBox).toEqual(ANALYSIS);
  });

  it("模型把题干图标成了解法图 → 同样按位置纠正", () => {
    const out = classifyFigures(item({ analysisFigureBox: STEM, answerTop: 0.72 }));
    expect(out.stemFigureBox).toEqual(STEM);
    expect(out.analysisFigureBox).toBeUndefined();
  });

  it("两张图都在灰框里时，都不当题干图", () => {
    const out = classifyFigures(
      item({ figureBox: [0.5, 0.78, 0.7, 0.9], analysisFigureBox: ANALYSIS, answerTop: 0.72 }),
    );
    expect(out.stemFigureBox).toBeUndefined();
    expect(out.analysisFigureBox).toBeDefined();
  });

  it("没有灰框（学生版）时信模型的标注——那种材料里本来就没有解法图", () => {
    const out = classifyFigures(item({ figureBox: STEM }));
    expect(out.stemFigureBox).toEqual(STEM);
    expect(out.analysisFigureBox).toBeUndefined();
  });

  it("没有图就两个都空", () => {
    expect(classifyFigures(item({ answerTop: 0.72 }))).toEqual({});
  });

  it("从模型输出里解析出 answerTop", () => {
    const items = parseLayout(
      '{"index":1,"preview":"甲","box":[0.08,0.05,0.92,0.4],"hasFigure":true,' +
        '"figureBox":[0.6,0.08,0.92,0.19],"analysisFigureBox":[0.15,0.25,0.4,0.38],"answerTop":0.22}',
    );
    const out = classifyFigures(items[0]!);
    expect(items[0]!.answerTop).toBe(0.22);
    expect(out.stemFigureBox).toEqual([0.6, 0.08, 0.92, 0.19]);
    expect(out.analysisFigureBox).toEqual([0.15, 0.25, 0.4, 0.38]);
  });

  it("answerTop 给成百分数也认；给成 null 就当没给", () => {
    expect(parseLayout('{"index":1,"preview":"甲","answerTop":22}')[0]!.answerTop).toBe(0.22);
    expect(parseLayout('{"index":1,"preview":"甲","answerTop":null}')[0]!.answerTop).toBeUndefined();
  });
});

describe("跨页", () => {
  /**
   * 讲义里一道题常被页边切开。两种切法都在实机上出过错：
   * ① 一题两问，第二问在下一页 → 第二问整个抽不出来
   * ② 教师版的解答落到下一页 → 那张解法图被当成题干配图
   */
  it("续页开头全是上一页的答案时，answerTop=0，图一律算解法图", () => {
    const items = parseLayout(
      '{"index":1,"preview":"（上一页那道题的解析）","box":[0.08,0.02,0.92,0.3],' +
        '"hasFigure":true,"figureBox":[0.15,0.06,0.4,0.24],"answerTop":0,"continued":true}',
    );
    expect(items[0]!.answerTop).toBe(0);
    const out = classifyFigures(items[0]!);
    // 这一段里没有任何题干，所以没有题干图
    expect(out.stemFigureBox).toBeUndefined();
    expect(out.analysisFigureBox).toEqual([0.15, 0.06, 0.4, 0.24]);
  });

  it("answerTop=0 不能被当成「没给」丢掉", () => {
    // 丢掉它就退回"信模型标注"，而模型把那张图标成了 figureBox——
    // 解法图于是成了题干图，正是跨页时出错的那条路径
    expect(parseLayout('{"index":1,"preview":"甲","answerTop":0}')[0]!.answerTop).toBe(0);
  });

  it("只有一个小问的续文照样是一道题", () => {
    const items = parseLayout(
      '{"index":1,"label":"","preview":"（2）如果每人多分2个，还剩几个？",' +
        '"box":[0.08,0.03,0.92,0.18],"hasFigure":false,"continued":true}',
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.continued).toBe(true);
  });
});

describe("续文里的图", () => {
  /**
   * 实机漏掉的那一个：第5讲 p5 整个页首是上一页那道题解析的后半截
   * （推演表 + 结论 + 【标注】），模型给的是
   *   {continued:true, figureBox:[0.11,0.05,0.46,0.27], answerTop:0.28}
   * 表在 0.05~0.27、answerTop 是 0.28（那是【标注】的位置，
   * 因为【答案】标签留在了上一页）→ 按位置判成"答案框之上"= 题干图。
   * 而那张表最后一行写着答案 10。孩子一打开就看见了。
   *
   * 真相是个不变量：续文接的是答案时，这一整块里根本没有题干。
   */
  const tail = (over: Partial<LayoutItem> = {}): LayoutItem => ({
    index: 1,
    label: "",
    preview: "从表二中看到，三个和尚水罐里的水以3为周期",
    hasFigure: true,
    continued: true,
    continuedKind: "answer",
    box: [0.08, 0.05, 0.92, 0.48],
    figureBox: [0.11, 0.05, 0.46, 0.27],
    answerTop: 0.28,
    ...over,
  });

  it("接的是答案时，图一律算解析图——answerTop 在续页上没有意义", () => {
    const out = classifyFigures(tail());
    expect(out.stemFigureBox).toBeUndefined();
    expect(out.analysisFigureBox).toEqual([0.11, 0.05, 0.46, 0.27]);
  });

  it("模型没说接的是哪一半时，按答案处理", () => {
    const out = classifyFigures(tail({ continuedKind: undefined }));
    expect(out.stemFigureBox).toBeUndefined();
  });

  it("接的是题干后半截时才可能有题干图（配图落到了下一页）", () => {
    const out = classifyFigures(
      tail({ continuedKind: "stem", figureBox: [0.11, 0.05, 0.46, 0.27], answerTop: 0.5 }),
    );
    expect(out.stemFigureBox).toEqual([0.11, 0.05, 0.46, 0.27]);
  });

  it("不是续文的题不受这条影响", () => {
    const out = classifyFigures(
      tail({ continued: false, continuedKind: undefined, answerTop: 0.5 }),
    );
    expect(out.stemFigureBox).toEqual([0.11, 0.05, 0.46, 0.27]);
  });

  it("从模型输出里解析出 continuedKind，缺省是 answer", () => {
    const a = parseLayout('{"index":1,"preview":"甲","continued":true}');
    expect(a[0]!.continuedKind).toBe("answer");
    const b = parseLayout('{"index":1,"preview":"甲","continued":true,"continuedKind":"stem"}');
    expect(b[0]!.continuedKind).toBe("stem");
    const c = parseLayout('{"index":1,"preview":"甲","continued":false}');
    expect(c[0]!.continuedKind).toBeUndefined();
  });
});

describe("光杆题号", () => {
  /**
   * 实测第10讲：练习7 的题号排在 p3 页脚、正文翻到 p4；练习9 的题号在 p4 页脚、
   * 正文在 p5。版面那趟给出的是
   *   {"label":"练习9","preview":"练习9","box":[0.12,0.89,0.89,0.91]}
   * ——一条 2% 高、只有题号的窄带。
   *
   * 此前把它当一道题去抽：框太窄被 normalizeBox 判废、退回整页，
   * 抽出来的是同页别的题，再被查重挡掉；而下一页的正文标着 continued，
   * 被并进了上一道题。13 道题里这么丢了 2 道。
   */
  const item = (over: Partial<LayoutItem> = {}): LayoutItem => ({
    index: 3,
    label: "练习9",
    preview: "练习9",
    hasFigure: false,
    continued: false,
    ...over,
  });

  it("preview 与 label 一样 = 这条里没有题干", () => {
    expect(isDanglingLabel(item())).toBe(true);
  });

  it("preview 为空也算", () => {
    expect(isDanglingLabel(item({ preview: "" }))).toBe(true);
  });

  it("preview 是旁边的章节标题也算——判据是位置不是字面", () => {
    // 实测第10讲 p3：练习7 的题号在页底，模型给的 preview 是「二、转动数学大脑」。
    // 只看「preview 等于 label」会漏掉它，而它一直只占页底 4% 的窄带
    expect(
      isDanglingLabel(item({ label: "练习7", preview: "二、转动数学大脑", box: [0.08, 0.88, 0.92, 0.92] })),
    ).toBe(true);
    // 同一页跑两次，模型给的框时窄时宽——所以判据不能只看框高
    expect(
      isDanglingLabel(item({ label: "练习7", preview: "二、转动数学大脑", box: [0.08, 0.82, 0.92, 0.99] })),
    ).toBe(true);
  });

  it("有题干就不是光杆", () => {
    expect(isDanglingLabel(item({ preview: "如图，从梯形ABCD中分出两个平行四边形" }))).toBe(false);
  });

  it("不在页面下方的条目不算——那是一道真题，哪怕开头几个字很短", () => {
    expect(isDanglingLabel(item({ preview: "计算：", box: [0.08, 0.2, 0.92, 0.8] }))).toBe(false);
  });

  /**
   * 这个判断**只决定"下一页开头算不算新题"，不决定丢不丢这一条**。
   * 两件事一度绑在一起，于是成了一个两头都会出错的单点判断：
   * 判松了丢真题（页底一道开头很短的题被整条扔掉），
   * 判紧了吞新题（跨页那道被并进上一题）。实机上两种都发生过。
   * 拆开之后就可以判松——认错了只是让下一页开头多当一次新题。
   */
  it("页底开头很短的条目也算——反正这一条照样会被抽取", () => {
    expect(isDanglingLabel(item({ label: "练习5", preview: "如图，求阴影面积", box: [0.08, 0.78, 0.92, 0.95] }))).toBe(
      true,
    );
  });

  it("没有题号的条目不算——那是别的情况（比如续文）", () => {
    expect(isDanglingLabel(item({ label: "", preview: "时间过得真快啊，一转眼" }))).toBe(false);
  });

  it("从真实版面输出里认出来", () => {
    const items = parseLayout(
      [
        '{"index":2,"label":"练习8","preview":"丁丁拿到的题目：如图，从梯形ABCD中分出","box":[0.12,0.46,0.89,0.86],"hasFigure":true}',
        '{"index":3,"label":"练习9","preview":"练习9","box":[0.12,0.89,0.89,0.91]}',
      ].join("\n"),
    );
    // 光杆题号没有框，排序时不能被当成 y=0 排到最前——它在页面最底下
    expect(items.map((i) => i.label)).toEqual(["练习8", "练习9"]);
    expect(items.map(isDanglingLabel)).toEqual([false, true]);
    // 那条窄带的框本来就过不了校验（高 2%），所以它连裁都裁不出来
    expect(items[1]!.box).toBeUndefined();
  });
});

describe("排序时没有框的条目", () => {
  /**
   * 曾经把"没有框"当成 y=0，于是页脚那个光杆题号（框太窄被判废）
   * 排到了整页最前面。位置错了两件事跟着错：
   * 「最后一条是不是光杆题号」检测不出来，snapBoxes 也会照着错的顺序补边界。
   */
  it("沿用模型给的阅读顺序，不排到最前面", () => {
    const items = parseLayout(
      [
        '{"index":1,"label":"练习1","preview":"甲","box":[0.08,0.05,0.92,0.3]}',
        '{"index":2,"label":"练习2","preview":"乙","box":[0.08,0.35,0.92,0.6]}',
        '{"index":3,"label":"练习3","preview":"练习3"}',
      ].join("\n"),
    );
    expect(items.map((i) => i.label)).toEqual(["练习1", "练习2", "练习3"]);
  });

  it("模型顺序颠倒时仍按纵向位置纠正", () => {
    const items = parseLayout(
      [
        '{"index":1,"label":"下面那道","preview":"甲","box":[0.08,0.5,0.92,0.8]}',
        '{"index":2,"label":"上面那道","preview":"乙","box":[0.08,0.05,0.92,0.3]}',
      ].join("\n"),
    );
    expect(items.map((i) => i.label)).toEqual(["上面那道", "下面那道"]);
  });

  it("补边界按纠正后的顺序来", () => {
    const items = parseLayout(
      [
        '{"index":1,"label":"甲","preview":"甲","box":[0.08,0.05,0.92,0.2]}',
        '{"index":2,"label":"乙","preview":"乙题干","box":[0.08,0.5,0.92,0.7]}',
      ].join("\n"),
    );
    expect(items[0]!.box![3]).toBe(0.5);
  });
});

describe("repairJsonEscapes", () => {
  /**
   * 实机上丢题最多的一处：模型写题干带 LaTeX，`\div` 在 JSON 里是非法转义，
   * JSON.parse 抛错 → 整道题被跳过 → 界面上只显示"这一块没读出题目"。
   * 提示词里加了"分数根号要写成 LaTeX"之后，一份 13 道题的讲义连着掉到 8 道。
   */
  it("落单的反斜杠补成一对，题就解析得出来了", () => {
    const raw = '{"analysis":"底 $CD = 48 \\div 8 = 6$ 厘米"}';
    expect(() => JSON.parse(raw)).toThrow();
    expect(JSON.parse(repairJsonEscapes(raw)).analysis).toBe("底 $CD = 48 \\div 8 = 6$ 厘米");
  });

  it.each([
    ["分数", '{"a":"$\\frac{1}{4}$"}'],
    ["根号", '{"a":"$\\sqrt{16}$"}'],
    ["角度", '{"a":"$45^\\circ$"}'],
    ["垂直", '{"a":"$FG \\perp AD$"}'],
  ])("常见的 LaTeX：%s", (_why, raw) => {
    expect(() => JSON.parse(repairJsonEscapes(raw))).not.toThrow();
  });

  it("已经写对的转义不能被再翻一倍", () => {
    const raw = '{"a":"换行\\n引号\\"斜杠\\\\结束"}';
    expect(JSON.parse(repairJsonEscapes(raw)).a).toBe(JSON.parse(raw).a);
  });

  it("结构本身一个字节不碰", () => {
    const raw = '{"a":1,"b":[2,3],"c":{"d":null}}';
    expect(repairJsonEscapes(raw)).toBe(raw);
  });

  it("字符串外面的反斜杠不动（本来也不该有）", () => {
    expect(repairJsonEscapes('{"a":1} \\ 尾巴')).toBe('{"a":1} \\ 尾巴');
  });

  it("整条流程：带 LaTeX 的多行输出照样抠得出对象", () => {
    const raw = [
      "{",
      '"stem": "已知平行四边形 $ABCD$ 的面积是 $48$ 平方厘米，高 $AE=8$ 厘米",',
      '"answer": "6",',
      '"analysis": "底 $CD = 48 \\div 8 = 6$ 厘米。"',
      "}",
    ].join("\n");
    const obj = parseFirstObject(raw) as Record<string, string>;
    expect(obj.answer).toBe("6");
    expect(obj.analysis).toContain("\\div");
  });
});

describe("题干图不许越过答案线", () => {
  /**
   * 实机：练习4（五次测验统计图）的图框上边在题干里、下边伸进了【答案】灰框，
   * 裁出来的"题干配图"底部印着「【答案】92」——正是要孩子算的平均分。
   */
  const item = (over: Partial<LayoutItem> = {}): LayoutItem => ({
    index: 1,
    label: "练习4",
    preview: "如图，是牛牛五次数学测验成绩的统计图",
    hasFigure: true,
    continued: false,
    box: [0.08, 0.05, 0.92, 0.6],
    answerTop: 0.4,
    ...over,
  });

  it("下边越线的题干图裁到答案线为止", () => {
    const out = classifyFigures(item({ figureBox: [0.5, 0.1, 0.92, 0.55] }));
    expect(out.stemFigureBox).toEqual([0.5, 0.1, 0.92, 0.4]);
  });

  it("裁完剩不下什么就整个不要——宁可没图也不能把答案递过去", () => {
    const out = classifyFigures(item({ figureBox: [0.5, 0.39, 0.92, 0.55] }));
    expect(out.stemFigureBox).toBeUndefined();
  });

  it("没越线的不动", () => {
    const out = classifyFigures(item({ figureBox: [0.5, 0.1, 0.92, 0.35] }));
    expect(out.stemFigureBox).toEqual([0.5, 0.1, 0.92, 0.35]);
  });

  it("没有答案线（学生版）时不裁", () => {
    const out = classifyFigures(item({ answerTop: undefined, figureBox: [0.5, 0.1, 0.92, 0.55] }));
    expect(out.stemFigureBox).toEqual([0.5, 0.1, 0.92, 0.55]);
  });
})

describe("版面条目级的小问合并", () => {
  /**
   * 实机（第14讲练习6）：版面把 (1)(2)(3) 切成独立条目，各走一次内容抽取，
   * 抽成三道题、只有第一道有图。草稿层按题干开头兜底不可靠——
   * 内容模型重写题干时常把「（2）」抹掉。条目层的 preview 是页面原文，
   * 编号还在，在这里并最稳。
   */
  const jsonl = [
    '{"index":1,"label":"练习6","preview":"根据某小学一至六年级喜欢看科普读物的人数绘制如下统计图","box":[0.08,0.23,0.92,0.5],"hasFigure":true,"figureBox":[0.58,0.29,0.88,0.44]}',
    '{"index":2,"label":"","preview":"（1）四年级喜欢看科普读物的学生人数是多少？","box":[0.08,0.5,0.92,0.55]}',
    '{"index":3,"label":"","preview":"（2）丁丁所在年级喜欢看科普读物的人数排第2位","box":[0.08,0.55,0.92,0.6],"answerTop":0.62}',
  ].join("\n");

  it("小问条目并回主题干，框取并集", () => {
    const items = parseLayout(jsonl);
    expect(items).toHaveLength(1);
    // snapBoxes 会把最后一条的框补到页底（收进答案块），所以下边是 1
    expect(items[0]!.box).toEqual([0.08, 0.23, 0.92, 1]);
    expect(items[0]!.figureBox).toEqual([0.58, 0.29, 0.88, 0.44]);
    expect(items[0]!.answerTop).toBe(0.62);
  });

  it("页首第一条就是小问时不并——那可能是跨页续文，归别的机制管", () => {
    const items = parseLayout(
      '{"index":1,"label":"","preview":"（2）丁丁所在年级排第2位","box":[0.08,0.05,0.92,0.2],"continued":true}',
    );
    expect(items).toHaveLength(1);
  });

  it("正常的两道题不受影响", () => {
    const items = parseLayout(
      [
        '{"index":1,"label":"练习7","preview":"乐乐老师让同学们做调查","box":[0.08,0.1,0.92,0.5]}',
        '{"index":2,"label":"练习8","preview":"牛牛来到工厂","box":[0.08,0.55,0.92,0.9]}',
      ].join("\n"),
    );
    expect(items).toHaveLength(2);
  });
});
