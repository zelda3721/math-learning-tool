import { describe, expect, it } from "vitest";
import { parseExtractionOutcome } from "../src/ingest/extraction.js";

const one = (stem: string, answer: string) =>
  `{"stem":"${stem}","answer":"${answer}","answerType":"numeric","difficulty":2,"level":"elementary_upper"}`;

describe("抽取输出解析：截断只该损失最后一题", () => {
  it("正常数组照常解析", () => {
    const r = parseExtractionOutcome(`[${one("甲题", "1")},${one("乙题", "2")}]`, "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["甲题", "乙题"]);
    expect(r.skipped).toBe(0);
  });

  it("在最后一个对象中间被截断时，前面的题全部保住", () => {
    // 实机报错就是这个：一页 12 道题，模型在第 92 行断掉，
    // JSON.parse 整段必然失败，于是整页颗粒无收。
    const truncated = `[${one("甲题", "1")},${one("乙题", "2")},{"stem":"丙题","answer":"3","ans`;
    const r = parseExtractionOutcome(truncated, "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["甲题", "乙题"]);
    expect(r.skipped).toBe(0); // 残缺那段压根没形成对象，不计入跳过
  });

  it("代码围栏没闭合（同样是截断的症状）也能解析", () => {
    const r = parseExtractionOutcome("```json\n[" + one("甲题", "1") + ",", "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["甲题"]);
  });

  it("中间某道题格式坏掉，只跳过它一条", () => {
    const bad = `[${one("甲题", "1")},{"stem":"乙题","answer":},${one("丙题", "3")}]`;
    const r = parseExtractionOutcome(bad, "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["甲题", "丙题"]);
    expect(r.skipped).toBe(1);
  });

  it("题干里带花括号或转义引号不会把切分弄乱", () => {
    const tricky = `[{"stem":"求 f(x)={x+1} 的值，注意\\"括号\\"","answer":"3","answerType":"numeric","difficulty":2,"level":"middle"}]`;
    const r = parseExtractionOutcome(tricky, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]!.stem).toContain("{x+1}");
  });

  it("一个 { 都没有 = 这一页没题，不是失败", () => {
    // 提示词自己写着"材料里没有题目时什么都不输出"，封面页、章节页、
    // 整页解析都会走到这里。此前一律抛错，一本讲义里几张没题的页面
    // 就成了刺眼的红色报错。
    const r = parseExtractionOutcome("材料中没有题目，不输出任何内容。", "elementary_upper");
    expect(r.drafts).toEqual([]);
    expect(r.empty).toBe(true);
  });

  it("有 { 却抠不出完整对象 = 写到一半断了，这才算失败", () => {
    expect(() => parseExtractionOutcome('{"stem":"一个长方', "elementary_upper")).toThrow(/截断/);
  });

  it("单个对象（没包数组）也认", () => {
    const r = parseExtractionOutcome(one("独题", "7"), "elementary_upper");
    expect(r.drafts.map((d) => d.stem)).toEqual(["独题"]);
  });
})

/**
 * 可选字段写成 null。
 *
 * 这是实机上丢题最多的一处，也藏得最深：模型时而写 `"problemTypeId":""`、
 * 时而写 `"problemTypeId":null`，写 null 那次整道题被 schema 判废、静默丢掉，
 * 界面上只剩一句"这一块没读出题目"。同一张图连打两次一次成一次败，
 * 看着像模型随机，其实是这里。一份 13 道的讲义反复抽出 8~11 道，根子在此。
 */
describe("可选字段为 null 时不能丢题", () => {
  const base =
    '{"stem":"如图，小正方形ABCD放在大正方形EFGH的上面，求梯形AFGD的面积","answer":"98",' +
    '"answerType":"numeric","difficulty":3,"level":"elementary_upper"';

  it.each([
    ["problemTypeId", '"problemTypeId":null'],
    ["nodeIds", '"nodeIds":null'],
    ["options", '"options":null'],
    ["analysis", '"analysis":null'],
    ["answerFrom", '"answerFrom":null'],
    ["answerUnique", '"answerUnique":null'],
    ["answer", '"answer":null'],
    ["difficulty", '"difficulty":null'],
    ["level", '"level":null'],
  ])("%s 为 null 时题目照样收下", (_field, pair) => {
    const r = parseExtractionOutcome(`${base},${pair}}`, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    expect(r.skipped).toBe(0);
    expect(r.drafts[0]!.stem).toContain("小正方形");
  });

  it("整份都写成 null 也接得住——抽取器的职责是尽量把题接住", () => {
    const raw =
      '{"stem":"求梯形的面积","answer":null,"answerType":null,"options":null,"analysis":null,' +
      '"difficulty":null,"level":null,"nodeIds":null,"problemTypeId":null,"answerFrom":null}';
    const r = parseExtractionOutcome(raw, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    // 缺的字段走缺省，不是把题扔掉
    expect(r.drafts[0]!.answerType).toBe("numeric");
    expect(r.drafts[0]!.level).toBe("elementary_upper");
    expect(r.drafts[0]!.difficulty).toBe(2);
  });

  it("题干本身缺失才该判废——那确实不是一道题", () => {
    expect(parseExtractionOutcome('{"answer":"98"}', "elementary_upper").drafts).toHaveLength(0);
  });
});

/**
 * 一题多问被拆散。
 *
 * 整页抽取的提示词写着"一行一道题"，模型于是把一题多问拆成了多行：
 * 实机上「田田来到希望小学…统计如下(表格)」之后跟着三条孤儿小问，
 * 「(3) 哪种标本的件数最多？」单独放着根本没法答。
 */
describe("被拆散的小问并回主题干", () => {
  const line = (stem: string, answer: string) =>
    JSON.stringify({ stem, answer, answerType: "numeric", difficulty: 2, level: "elementary_upper" });

  it("主题干 + 三条小问 → 一道题", () => {
    const raw = [
      line("田田来到一所希望小学，五、六年级同学制作标本情况统计如下：", "168"),
      line("(1) 根据统计表数据，将总数填入表格。", "40,72,56"),
      line("(2) 绘制复式条形统计图。", "见解析"),
      line("(3) 哪种标本的件数最多？", "植物"),
    ].join("\n");
    const r = parseExtractionOutcome(raw, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    const q = r.drafts[0]!;
    expect(q.stem).toContain("统计如下");
    expect(q.stem).toContain("(3) 哪种标本");
    expect(q.answer).toBe("168；40,72,56；见解析；植物");
  });

  it("本来就以 (1) 开头的独立计算题不动", () => {
    // 「(1) 127×123. (2) 229×221.」整体是一道题，模型没拆它时也别帮倒忙
    const raw = line("(1) 127 × 123 . (2) 229 × 221 .", "15621；50609");
    expect(parseExtractionOutcome(raw, "elementary_upper").drafts).toHaveLength(1);
  });

  it("两道正常的题不会被并起来", () => {
    const raw = [line("第一道题", "1"), line("第二道题", "2")].join("\n");
    expect(parseExtractionOutcome(raw, "elementary_upper").drafts).toHaveLength(2);
  });

  it("带圈编号也认", () => {
    const raw = [line("主题干带表格", "10"), line("① 第一问", "3"), line("② 第二问", "7")].join("\n");
    const r = parseExtractionOutcome(raw, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]!.answer).toBe("10；3；7");
  });

  it("小问答案与主答案相同（模型两边都写）时不重复", () => {
    const raw = [line("主题干", "42"), line("(1) 唯一的小问", "42")].join("\n");
    expect(parseExtractionOutcome(raw, "elementary_upper").drafts[0]!.answer).toBe("42");
  });
})

/**
 * 拆散的第二种花样：**重复题干**。
 *
 * 每条都是「完整题干＋一个小问」——开头不是编号，按"开头是小问"的判据
 * 完全看不见。第14讲练习6 连着两轮就是这么漏掉的（题干原文取自实机题库）。
 */
describe("重复题干式的拆散", () => {
  const line = (stem: string, answer: string) =>
    JSON.stringify({ stem, answer, answerType: "numeric", difficulty: 2, level: "elementary_upper" });
  const HEAD = "根据某小学一至六年级喜欢看科普读物的人数绘制如下统计图，根据统计图回答下列问题．";

  it("三条重复题干的碎片并成一道", () => {
    const raw = [
      line(`${HEAD}（1）四年级喜欢看科普读物的学生人数是多少？`, "57"),
      line(`${HEAD}（2）丁丁所在年级喜欢看科普读物的人数排第2位，丁丁是哪个年级的？`, "五年级"),
      line(`${HEAD}（3）你还能提出什么数学问题？`, "合理即可"),
    ].join("\n");
    const r = parseExtractionOutcome(raw, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    const q = r.drafts[0]!;
    // 题干只留一份，小问接排
    expect(q.stem.match(/根据某小学/g)).toHaveLength(1);
    expect(q.stem).toContain("（1）四年级");
    expect(q.stem).toContain("（3）你还能");
    expect(q.answer).toBe("57；五年级；合理即可");
  });

  it("题干不同的两道题不会被并——头对不上", () => {
    const raw = [
      line("甲店的统计图如下（1）多少人？", "10"),
      line("乙店的统计图如下（1）多少人？", "20"),
    ].join("\n");
    expect(parseExtractionOutcome(raw, "elementary_upper").drafts).toHaveLength(2);
  });

  it("头太短时不并——短前缀撞车太容易", () => {
    const raw = [line("如图（1）求角度", "30"), line("如图（2）求边长", "5")].join("\n");
    expect(parseExtractionOutcome(raw, "elementary_upper").drafts).toHaveLength(2);
  });
})

/**
 * 小问编号被 LaTeX 包住：「（$1$）」。
 * 提示词要求数字用 $ 包起来，模型把小问编号也一并包了——
 * 实机上练习13 的三条碎片就是靠它躲过合并的（题干取自实机题库）。
 */
describe("LaTeX 包裹的小问编号", () => {
  const line = (stem: string, answer: string) =>
    JSON.stringify({ stem, answer, answerType: "numeric", difficulty: 3, level: "elementary_upper" });
  const HEAD =
    "如图，$A$，$B$两地相距$1500$米，实线表示牛牛上午$8$时由$A$地出发往$B$地行走，虚线表示丁丁的步行情况。";

  it("三条「（$n$）」碎片并成一道", () => {
    const raw = [
      line(`${HEAD}（$1$）牛牛在$B$地休息了多长时间？`, "13分钟；75米/分，60米/分"),
      line(`${HEAD}（$2$）丁丁的速度各是多少？`, "50米/分，50米/分"),
      line(`${HEAD}（$3$）牛牛和丁丁相遇了几次？`, "两次；8点12分"),
    ].join("\n");
    const r = parseExtractionOutcome(raw, "elementary_upper");
    expect(r.drafts).toHaveLength(1);
    const q = r.drafts[0]!;
    expect(q.stem.match(/两地相距/g)).toHaveLength(1);
    expect(q.stem).toContain("（$3$）");
    expect(q.answer).toBe("13分钟；75米/分，60米/分；50米/分，50米/分；两次；8点12分");
  });

  it("题干里正常的 $ 数学（如 $1500$ 米）不会被当成编号", () => {
    // $1500$ 不带括号，不匹配；只有括号包着的 $n$ 才算
    const raw = line(`${HEAD}求两地距离。`, "1500");
    expect(parseExtractionOutcome(raw, "elementary_upper").drafts).toHaveLength(1);
  });
})
