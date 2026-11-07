import type { ReactElement } from 'react'
import type { WidgetKind } from '@mathtutor/widgets'
import type { WidgetViewProps } from './palette'
import { NumberLineJump } from './NumberLineJump'
import { FractionBar } from './FractionBar'
import { BalanceScale } from './BalanceScale'
import { ClockFace } from './ClockFace'
import { AreaGrid } from './AreaGrid'
import { Base10Blocks } from './Base10Blocks'
import { PatternTrain } from './PatternTrain'
import { SortingBins } from './SortingBins'
import { CoordinatePlot } from './CoordinatePlot'
import { MoneyChange } from './MoneyChange'

export type { WidgetViewProps } from './palette'

/**
 * kind → 渲染器。
 *
 * 用 Record<WidgetKind, …> 而不是稀疏的 switch：将来加第十一个组件时，
 * 少写一个渲染器会在编译期报错，而不是在孩子的屏幕上留一块空白。
 * 每个渲染器都是纯展示：只读 state 与 spec，**不改状态、不判对错**。
 */
export const WIDGET_VIEWS: Record<WidgetKind, (props: WidgetViewProps) => ReactElement> = {
  number_line_jump: NumberLineJump,
  fraction_bar: FractionBar,
  balance_scale: BalanceScale,
  clock_face: ClockFace,
  area_grid: AreaGrid,
  base10_blocks: Base10Blocks,
  pattern_train: PatternTrain,
  sorting_bins: SortingBins,
  coordinate_plot: CoordinatePlot,
  money_change: MoneyChange,
}
