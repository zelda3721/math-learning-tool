/**
 * 公式的逐项显现（"按 token 动画"里真正与时间有关的那一半）。
 *
 * 另一半——**怎么把一条公式拆成 token 而不毁掉排版**——属于渲染器，不在这里：
 * KaTeX 的间距是整体算出来的，把 `x^2+3` 拆成三段各自渲染再拼回去，
 * 加号的左右间距会错、分数线会断。正确做法是**整体渲染一次**，再按 DOM 里的
 * 顶层原子控制透明度——排版不动，只动可见性。
 *
 * 所以这个模块只回答一个问题：进度到 p 时，前几个原子该可见。
 * 它是纯的，能离开浏览器测，也能保证"同一 p 必得同一画面"。
 */

/**
 * 进度 p 时应当可见的原子个数（0..total）。
 *
 * 用"整段均分 + 向上取整"而不是缓动：公式逐项显现的节奏应当是可预测的
 * （第 3 项在第 3/total 处出现），缓动会让"说到哪一项"和"看到哪一项"错开，
 * 而讲解的旁白正是按项走的。
 */
export function revealedAtoms(local: number, total: number): number {
  const n = Math.max(0, Math.floor(total));
  if (n === 0) return 0;
  const p = Number.isFinite(local) ? Math.max(0, Math.min(1, local)) : 0;
  if (p >= 1) return n;
  return Math.min(n, Math.ceil(p * n));
}

/**
 * 每个原子的不透明度。
 *
 * 已出现的给 1，正要出现的那一个给中间值——不这样做的话，原子会以
 * "整块跳出"的方式出现，读起来像插图换了而不是公式在写。
 */
export function atomOpacity(index: number, local: number, total: number): number {
  const shown = revealedAtoms(local, total);
  if (index < shown - 1) return 1;
  if (index === shown - 1) {
    // 刚出现的那一个：用小数部分做淡入，末尾正好到 1
    const p = Number.isFinite(local) ? Math.max(0, Math.min(1, local)) : 0;
    const exact = p * total;
    const frac = exact - Math.floor(exact);
    return Math.min(1, 0.35 + 0.65 * (frac === 0 ? 1 : frac));
  }
  return 0;
}
