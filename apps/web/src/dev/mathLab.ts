/**
 * 公式实验台（仅冒烟测试用）。
 *
 * 验的是一件具体的事：**逐项显现时公式的排版一点都不能动**。
 * 如果切分方式错了（比如拆成几段各自渲染），下面断言里的宽度会变——
 * 那一变，观众看到的就是"公式在跳"，不是"公式在写"。
 */
import { applyAtomOpacity, renderMathAtoms } from '../math/katexAtoms'

const stage = document.getElementById('math-stage')
if (!stage) throw new Error('实验台缺少 #math-stage')

const rendered = renderMathAtoms('x^2 + 3x - 4 = 0')
stage.appendChild(rendered.root)

interface MathLabHandle {
  /** 原子个数 */
  atoms(): number
  /** 设进度，返回此刻可见原子数 */
  seek(local: number): number
  /** 整块公式的宽度：逐项显现过程中必须恒定 */
  width(): number
}

declare global {
  interface Window {
    __mathLab?: MathLabHandle
  }
}

window.__mathLab = {
  atoms: () => rendered.atoms.length,
  seek: (local: number) => applyAtomOpacity(rendered.atoms, local),
  width: () => rendered.root.getBoundingClientRect().width,
}
