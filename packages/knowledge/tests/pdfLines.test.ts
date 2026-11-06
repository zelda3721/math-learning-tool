import { describe, expect, it } from "vitest";
import { reconstructLines, type PdfTextItem } from "../src/pdfLines.js";

/** 造一个文本项：x/y 是 PDF 坐标（y 向上为正），s 是字号 */
function item(str: string, x: number, y: number, s = 11): PdfTextItem {
  return { str, transform: [s, 0, 0, s, x, y] };
}

describe("reconstructLines 行重建", () => {
  it("同一基线的片段按 x 排序后合成一行", () => {
    const lines = reconstructLines([item("are", 90, 700), item("am/is/", 40, 700)]);
    expect(lines).toEqual(["am/is/ are"]);
  });

  it("不同字号的标题与编号仍在同一行——基线差几个单位不该拆行", () => {
    // 真实教材里「Unit」「1」「am/is/are」三种字号，基线 y 分别是 700 / 702.5 / 698
    const lines = reconstructLines([
      item("am/is/are", 120, 698, 14),
      item("1", 85, 702.5, 24),
      item("Unit", 40, 700, 10),
    ]);
    expect(lines).toEqual(["Unit 1 am/is/are"]);
  });

  it("基线相距足够远就是不同的行，自上而下输出", () => {
    const lines = reconstructLines([
      item("正文第二行", 40, 680),
      item("标题", 40, 700),
      item("正文第三行", 40, 660),
    ]);
    expect(lines).toEqual(["标题", "正文第二行", "正文第三行"]);
  });

  it("中文片段之间不留空格，中英之间留", () => {
    expect(reconstructLines([item("分数", 40, 700), item("的意义", 90, 700)])).toEqual(["分数的意义"]);
    expect(reconstructLines([item("Unit", 40, 700), item("分数", 80, 700)])).toEqual(["Unit 分数"]);
  });

  it("空片段与缺 transform 的标记项被跳过", () => {
    const lines = reconstructLines([
      item("  ", 40, 700),
      { str: "", transform: [1, 0, 0, 1, 0, 0] },
    ]);
    expect(lines).toEqual([]);
  });
});
