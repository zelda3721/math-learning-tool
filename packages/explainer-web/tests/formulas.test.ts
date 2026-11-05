import { describe, expect, it } from "vitest";
import { atomOpacity, revealedAtoms } from "../src/formulas.js";

/**
 * 公式逐项显现只做"进度 → 可见原子数"这一件事。
 * 拆 token 是渲染器的事（KaTeX 要整体渲染一次才不毁间距），
 * 这里不碰 DOM——所以它能离开浏览器把确定性钉住。
 */

describe("revealedAtoms", () => {
  it("两端精确：0 个可见 → 全部可见", () => {
    expect(revealedAtoms(0, 5)).toBe(0);
    expect(revealedAtoms(1, 5)).toBe(5);
    expect(revealedAtoms(2, 5)).toBe(5); // 越界钳制
  });

  it("均匀推进：第 k 项在 k/total 处出现（旁白按项走，节奏必须可预测）", () => {
    expect(revealedAtoms(0.2, 5)).toBe(1);
    expect(revealedAtoms(0.4, 5)).toBe(2);
    expect(revealedAtoms(0.6, 5)).toBe(3);
    expect(revealedAtoms(0.8, 5)).toBe(4);
  });

  it("0 个原子与脏输入不炸", () => {
    expect(revealedAtoms(0.5, 0)).toBe(0);
    expect(revealedAtoms(Number.NaN, 4)).toBe(0);
    expect(revealedAtoms(-3, 4)).toBe(0);
  });

  it("纯粹：同一进度反复求值恒等", () => {
    expect(revealedAtoms(0.37, 7)).toBe(revealedAtoms(0.37, 7));
  });
});

describe("atomOpacity", () => {
  it("已出现的给满不透明，未出现的完全透明", () => {
    expect(atomOpacity(0, 0.6, 5)).toBe(1);
    expect(atomOpacity(4, 0.6, 5)).toBe(0);
  });

  it("正要出现的那一个给中间值：整块跳出读起来像换了插图，不像在写公式", () => {
    const mid = atomOpacity(2, 0.42, 5); // 第 3 个刚出现
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(1);
  });

  it("末尾全部为 1", () => {
    for (let i = 0; i < 5; i += 1) expect(atomOpacity(i, 1, 5)).toBe(1);
  });
});
