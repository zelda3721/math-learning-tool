/**
 * 公式的逐项显现（在浏览器里做的那一半）。
 *
 * **为什么必须整体渲染一次再切 DOM，而不是把公式拆成几段分别渲染：**
 * KaTeX 的间距是整体算出来的——`x^2+3` 拆成 `x^2`、`+`、`3` 三段各自渲染再拼回去，
 * 加号左右的间距会变、分数线会断、上下标的相对位置也会漂。那是"看起来像公式"
 * 而不是"公式"。所以这里先让 KaTeX 排版好，再按顶层原子控制透明度：
 * **排版一次算准，动效只动可见性**。
 *
 * 时间那一半（进度 → 可见几个原子）在 `@mathtutor/explainer-web` 的 formulas.ts，
 * 是纯函数、有单测；这里是它唯一被允许碰 DOM 的地方。
 */
import katex from 'katex'
import { atomOpacity, revealedAtoms } from '@mathtutor/explainer-web'

export interface RenderedMath {
  /** 整块（`.katex`），直接塞进容器即可 */
  root: HTMLElement
  /**
   * 顶层原子。一个分数、一个上下标整体算**一个**原子：
   * 它们是排版上的一个单元，拆开反而会散架。
   */
  atoms: HTMLElement[]
}

/** 渲染一条公式，并交出它的顶层原子 */
export function renderMathAtoms(tex: string, displayMode = false): RenderedMath {
  const holder = document.createElement('div')
  katex.render(tex, holder, { displayMode, throwOnError: false, output: 'html' })
  const root = holder.firstElementChild as HTMLElement
  const base = root.querySelector('.katex-html > .base')
  const atoms = base ? (Array.from(base.children) as HTMLElement[]) : []
  return { root, atoms }
}

/**
 * 按拍内进度设置原子可见性。返回当前可见的原子数（便于测试与调试）。
 *
 * 注意这里**只改 opacity**，不增删节点、不改尺寸：一增删，后面的原子就会挪位，
 * 观众看到的是"公式在跳"而不是"公式在写"。
 */
export function applyAtomOpacity(atoms: HTMLElement[], local: number): number {
  const total = atoms.length
  atoms.forEach((atom, index) => {
    atom.style.opacity = String(atomOpacity(index, local, total))
  })
  return revealedAtoms(local, total)
}
