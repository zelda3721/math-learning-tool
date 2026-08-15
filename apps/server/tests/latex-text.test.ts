/**
 * latexToPlainText：送讲解引擎前把 LaTeX 落成普通文字。
 * 讲解页跑在 sandbox iframe 里（没有 KaTeX）、SceneSpec 台词画在 canvas 上，
 * `$...$` 原样过去，孩子看到的就是美元符号——实机报的就是这个。
 */
import { describe, expect, it } from "vitest";
import { latexToPlainText } from "../src/latexText.js";

describe("latexToPlainText", () => {
  it("剥掉 $ 定界符（拍照识题的真实题干）", () => {
    expect(
      latexToPlainText(
        "如图，已知四边形$ABCD$中，$E$为$AD$边的中点，三角形$ABE$的面积为$12$平方厘米，则三角形$DFC$的面积为______平方厘米．",
      ),
    ).toBe(
      "如图，已知四边形ABCD中，E为AD边的中点，三角形ABE的面积为12平方厘米，则三角形DFC的面积为______平方厘米．",
    );
  });

  it("分数与四则符号", () => {
    expect(latexToPlainText("$\\frac{1}{2} \\times 4 \\div 2$")).toBe("1/2 × 4 ÷ 2");
    expect(latexToPlainText("$\\dfrac{3}{4}$")).toBe("3/4");
  });

  it("带分数不能拼成另一个数：50\\frac{1}{4} → 50 1/4", () => {
    expect(latexToPlainText("将 $50\\frac{1}{4}$ 与 49.99 比较")).toBe("将 50 1/4 与 49.99 比较");
  });

  it("复杂分子分母加括号保义", () => {
    expect(latexToPlainText("$\\frac{a+b}{2}$")).toBe("(a+b)/2");
  });

  it("嵌套分数从内往外收敛", () => {
    expect(latexToPlainText("$\\frac{1}{\\frac{1}{2}}$")).toBe("1/(1/2)");
  });

  it("根号、上标、角度", () => {
    expect(latexToPlainText("$\\sqrt{2}$ 和 $\\sqrt{a+1}$")).toBe("√2 和 √(a+1)");
    expect(latexToPlainText("边长 $a^2$，体积 $a^3$，角 $45^\\circ$")).toBe(
      "边长 a²，体积 a³，角 45°",
    );
    expect(latexToPlainText("$2^{10}$")).toBe("2^10");
  });

  it("几何记号与比较符", () => {
    expect(latexToPlainText("$\\angle ABC = 90^\\circ$，$AB \\parallel CD$，$a \\le b$")).toBe(
      "∠ABC = 90°，AB ∥ CD，a ≤ b",
    );
    expect(latexToPlainText("$\\overline{AB} = 3$")).toBe("AB = 3");
  });

  it("\\( \\) 与 \\[ \\] 定界符同样剥掉", () => {
    expect(latexToPlainText("\\(x+1\\) 与 \\[y-2\\]")).toBe("x+1 与 y-2");
  });

  it("认不得的命令原样保留——转错意思比难看更糟", () => {
    expect(latexToPlainText("$\\oiint f$")).toBe("\\oiint f");
  });

  it("括号残缺时不猜，原样保留", () => {
    expect(latexToPlainText("\\frac{1}{2 断了")).toBe("\\frac{1}{2 断了");
  });

  it("普通文字原样通过", () => {
    const plain = "一辆汽车 3 小时行驶 180 千米，5 小时行驶多少千米？";
    expect(latexToPlainText(plain)).toBe(plain);
  });
});
