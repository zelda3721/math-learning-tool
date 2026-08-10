import { describe, expect, it } from "vitest";
import { compileExpression, type EvalFn } from "../src/math/expr.js";

/** 编译必须成功，否则直接让测试失败并打印原因（不允许静默拿到假函数） */
const compile = (expr: string, variable = "x"): EvalFn => {
  const result = compileExpression(expr, variable);
  if (!result.ok) throw new Error(`compile failed for ${expr}: ${result.error}`);
  return result.fn;
};

describe("compileExpression — 真实取值", () => {
  it("x**2 - 4 的取值与根", () => {
    const f = compile("x**2 - 4");
    expect(f(0)).toBe(-4);
    expect(f(2)).toBe(0);
    expect(f(-2)).toBe(0);
    expect(f(3)).toBe(5);
  });

  it("2*x + 3 是线性的", () => {
    const f = compile("2*x + 3");
    expect(f(0)).toBe(3);
    expect(f(1)).toBe(5);
    expect(f(-1.5)).toBe(0);
  });

  it("sin(x) 与数学库一致", () => {
    const f = compile("sin(x)");
    expect(f(0)).toBe(0);
    expect(f(Math.PI / 2)).toBeCloseTo(1, 12);
    expect(f(Math.PI)).toBeCloseTo(0, 12);
  });

  it("1/x 在 x=0 无定义", () => {
    const f = compile("1/x");
    expect(f(2)).toBe(0.5);
    expect(f(-4)).toBe(-0.25);
    expect(f(0)).toBeNull();
  });

  it("sqrt(x) 在负数处无定义", () => {
    const f = compile("sqrt(x)");
    expect(f(9)).toBe(3);
    expect(f(0)).toBe(0);
    expect(f(-1)).toBeNull();
    expect(f(-0.0001)).toBeNull();
  });

  it("exp(-x**2) 是高斯钟形", () => {
    const f = compile("exp(-x**2)");
    expect(f(0)).toBe(1);
    expect(f(1)).toBeCloseTo(Math.exp(-1), 12);
    expect(f(-1)).toBeCloseTo(Math.exp(-1), 12);
    // 一元负号作用在整个幂上：-x**2 = -(x^2)，不是 (-x)^2
    expect(f(2)).toBeCloseTo(Math.exp(-4), 12);
  });

  it("log(x) 是自然对数且非正数无定义", () => {
    const f = compile("log(x)");
    expect(f(Math.E)).toBeCloseTo(1, 12);
    expect(f(1)).toBe(0);
    expect(f(0)).toBeNull();
    expect(f(-3)).toBeNull();
    expect(compile("ln(x)")(Math.E)).toBeCloseTo(1, 12);
    expect(compile("lg(x)")(1000)).toBeCloseTo(3, 12);
    expect(compile("log(x, 2)")(8)).toBeCloseTo(3, 12);
  });

  it("tan 在极点返回 null 而不是天文数字", () => {
    const f = compile("tan(x)");
    expect(f(0)).toBe(0);
    expect(f(Math.PI / 4)).toBeCloseTo(1, 12);
    expect(f(Math.PI / 2)).toBeNull();
  });

  it("asin/acos 在定义域外返回 null", () => {
    expect(compile("asin(x)")(2)).toBeNull();
    expect(compile("acos(x)")(-1.5)).toBeNull();
    expect(compile("asin(x)")(1)).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe("compileExpression — 记号等价与优先级", () => {
  it("x^2 与 x**2 等价", () => {
    const a = compile("x^2");
    const b = compile("x**2");
    for (const x of [-3, -1, 0, 0.5, 2, 7]) {
      expect(a(x)).toBe(b(x));
    }
    expect(a(3)).toBe(9);
  });

  it("^ 右结合", () => {
    expect(compile("2^3^2")(0)).toBe(512);
  });

  it("一元负号弱于幂", () => {
    expect(compile("-x^2")(3)).toBe(-9);
    expect(compile("(-x)^2")(3)).toBe(9);
  });

  it("乘除强于加减", () => {
    expect(compile("1 + 2*x")(3)).toBe(7);
    expect(compile("(1 + 2)*x")(3)).toBe(9);
  });

  it("指数侧允许一元负号", () => {
    expect(compile("2^-x")(2)).toBeCloseTo(0.25, 12);
  });

  it("常量 pi / e 与科学计数法", () => {
    expect(compile("pi")(0)).toBeCloseTo(Math.PI, 12);
    expect(compile("e")(0)).toBeCloseTo(Math.E, 12);
    expect(compile("1.5e2")(0)).toBe(150);
    expect(compile("2e-2")(0)).toBeCloseTo(0.02, 12);
  });

  it("SymPy 的大写函数名可读（Abs/Max/Sqrt）", () => {
    expect(compile("Abs(x)")(-4)).toBe(4);
    expect(compile("Max(x, 1)")(-4)).toBe(1);
    expect(compile("Sqrt(x)")(16)).toBe(4);
  });

  it("变量名优先于常量名", () => {
    const f = compile("e*2", "e");
    expect(f(5)).toBe(10);
  });

  it("自定义变量名 t", () => {
    const f = compile("t**2 + 1", "t");
    expect(f(3)).toBe(10);
    expect(compileExpression("x**2", "t").ok).toBe(false);
  });
});

describe("compileExpression — 非法输入必须诚实失败", () => {
  const bad = ["x; drop", "foo(x)", "(x + 1", "x +", "", "   ", "x @ 2", "sin", "sin(x, 2)", "x)"];
  for (const expr of bad) {
    it(`拒绝 ${JSON.stringify(expr)}`, () => {
      const result = compileExpression(expr, "x");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    });
  }

  it("未知符号会说明自变量是谁", () => {
    const result = compileExpression("y + 1", "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("y");
  });

  it("非法自变量名被拒绝", () => {
    expect(compileExpression("x", "2x").ok).toBe(false);
  });

  it("溢出与非有限输入返回 null 而不是 Infinity", () => {
    const f = compile("exp(x)");
    expect(f(100000)).toBeNull();
    expect(f(Number.NaN)).toBeNull();
    expect(f(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
