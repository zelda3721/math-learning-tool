import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { binsLayout, num, paramNum } from './layout'

/**
 * 分堆：三个筐并排，只有被选中的那个筐里有东西。
 *
 * 分类的规矩不是"看起来像"，是"能说出为什么在同一个筐里"。所以画面上
 * 三个筐始终同时在场、当前筐被高亮——孩子一眼能看到"我把它放进了哪一个"，
 * 而不是只看得到一个孤零零的计数。
 */
export function SortingBins({ spec, state }: WidgetViewProps) {
  const binCount = Math.max(
    1,
    Math.min(
      6,
      paramNum(spec.params, 'bins', 3),
    ),
  )
  const pick = spec.controls.find((c) => c.type === 'pick')
  const labels =
    pick && pick.type === 'pick' && pick.options.length > 0
      ? pick.options.slice(0, binCount)
      : Array.from({ length: binCount }, (_, i) => `筐 ${String.fromCharCode(65 + i)}`)
  const activeLabel = String(state.bin ?? labels[0])
  const count = num(state, 'count', 0)
  const bins = binsLayout(labels, activeLabel, count)

  const pad = 20
  const binW = 120
  const binGap = 18
  const binH = 96
  const y = 46
  const width = pad * 2 + bins.length * (binW + binGap) - binGap

  return (
    <svg
      viewBox={`0 0 ${width} 200`}
      className={SVG_CLASS}
      role="img"
      aria-label={`${activeLabel} 里放了 ${count} 个`}
    >
      {bins.map((bin) => {
        const x = pad + bin.index * (binW + binGap)
        // 筐画成上宽下窄的梯形：看得出"往里放"这件事
        const path = `M ${x} ${y} H ${x + binW} L ${x + binW - 14} ${y + binH} H ${x + 14} Z`
        return (
          <g key={bin.label}>
            <path
              d={path}
              fill={bin.active ? C.beamWash : C.plate}
              stroke={bin.active ? C.beam : C.rule}
              strokeWidth={bin.active ? 2.5 : 1.5}
            />
            <text x={x + binW / 2} y={y - 10} textAnchor="middle" fontSize={12} fill={bin.active ? C.beam : C.soft}>
              {bin.label}
            </text>
            {bin.active &&
              Array.from({ length: bin.count }, (_, i) => {
                const perRow = 5
                const row = Math.floor(i / perRow)
                const col = i % perRow
                return (
                  <circle
                    key={i}
                    cx={x + 14 + col * 18 + 3}
                    cy={y + 20 + row * 18}
                    r={6}
                    fill={C.beam}
                  />
                )
              })}
            <text x={x + binW / 2} y={y + binH + 18} textAnchor="middle" fontSize={12} fill={C.soft}>
              {bin.count > 0 ? `${bin.count} 个` : bin.active ? '空的' : '—'}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
