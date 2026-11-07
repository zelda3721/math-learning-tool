import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { paramNum, patternCars, patternUnit } from './layout'

/**
 * 规律火车：车厢按"一组"排队，组与组之间用括号标出来。
 *
 * 找规律不是数颜色，是看出"几节一循环"。所以第一个循环单元下面画了括号，
 * 后面每一节都由这个单元和后一项的决定推出来（而不是画死的红蓝红蓝）：
 * 换成"同一种颜色连下去"时，整个括号就变成 1 节，规律立刻塌掉——这正是要对比的。
 */
export function PatternTrain({ spec, state }: WidgetViewProps) {
  const length = paramNum(spec.params, 'length', 8)
  const alternate = Boolean(state.mode)
  const cars = patternCars(alternate, length)
  const unit = patternUnit(alternate)

  const carW = 48
  const carH = 42
  const gap = 12
  const pad = 20
  const y = 34
  const width = pad * 2 + Math.max(cars.length, 1) * (carW + gap) - gap

  return (
    <svg
      viewBox={`0 0 ${width} 132`}
      className={SVG_CLASS}
      role="img"
      aria-label={alternate ? '两节一组，红蓝交替' : '一节一组，同色连下去'}
    >
      {cars.map((tone, i) => {
        const x = pad + i * (carW + gap)
        const fill = tone === 'warm' ? C.correct : C.beam
        return (
          <g key={i}>
            {i > 0 && (
              <rect x={x - gap} y={y + carH / 2 - 2} width={gap} height={4} fill={C.soft} />
            )}
            <rect x={x} y={y} width={carW} height={carH} rx={7} fill={fill} />
            <circle cx={x + 12} cy={y + carH + 5} r={5} fill={C.ink} />
            <circle cx={x + carW - 12} cy={y + carH + 5} r={5} fill={C.ink} />
            <text x={x + carW / 2} y={y + carH / 2 + 5} textAnchor="middle" fontSize={12} fill={C.plate}>
              {i + 1}
            </text>
          </g>
        )
      })}

      {/* 一个循环单元：规律就写在这段括号里 */}
      {cars.length >= unit && (
        <g>
          <path
            d={`M ${pad} ${y - 8} v -6 H ${pad + unit * (carW + gap) - gap} v 6`}
            fill="none"
            stroke={C.soft}
            strokeWidth={1.5}
          />
          <text x={pad + (unit * (carW + gap) - gap) / 2} y={y - 20} textAnchor="middle" fontSize={11} fill={C.soft}>
            {alternate ? '一组 2 节，接着重复' : '一组 1 节，同色连下去'}
          </text>
        </g>
      )}
    </svg>
  )
}
