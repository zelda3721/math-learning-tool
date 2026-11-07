/**
 * 组件画面用的颜色与公共外形。
 *
 * 只用设计系统里的变量（不写死色号），因为深色/浅色主题都会换一套值；
 * 金色（lit）留给"学会了"，组件是交互，一律用 beam 靛蓝——
 * 孩子看到金色就应该想到星星亮了，不能在动手区里提前把它花掉。
 */
import type { WidgetSpec, WidgetState } from '@mathtutor/widgets'

export const C = {
  ink: 'var(--color-ink)',
  soft: 'var(--color-ink-soft)',
  faint: 'var(--color-ink-faint)',
  rule: 'var(--color-rule)',
  plate: 'var(--color-plate)',
  paper: 'var(--color-paper)',
  beam: 'var(--color-beam)',
  beamWash: 'var(--color-beam-wash)',
  correct: 'var(--color-correct)',
  correctWash: 'var(--color-correct-wash)',
  wrong: 'var(--color-wrong)',
  wrongWash: 'var(--color-wrong-wash)',
} as const

/** 每个 kind 的渲染器都只拿这两样：组件规格（画什么）+ 已经合法的状态 */
export interface WidgetViewProps {
  spec: WidgetSpec
  state: WidgetState
}

/** 画布统一：等比缩放、自适应宽度，窄屏也不会被撑破 */
export const SVG_CLASS = 'w-full h-auto select-none'
