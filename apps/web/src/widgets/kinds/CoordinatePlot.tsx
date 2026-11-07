import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { num, paramNum, plotPoint } from './layout'

/**
 * 格子上的点：先往右、再往上，落一个点。
 *
 * 顺序是坐标最容易错的地方（(3,2) 和 (2,3) 是两个地方），所以横走的那段虚线
 * 画粗一点、先出现，竖直那段接着画——把"先右后上"这个动作画出来。
 * 坐标转换只发生在 plotPoint 里，y 轴翻转也只在那里做一次。
 */
export function CoordinatePlot({ spec, state }: WidgetViewProps) {
  const maxX = paramNum(spec.params, 'maxX', 12)
  const maxY = paramNum(spec.params, 'maxY', 12)
  const x = num(state, 'x', 0)
  const y = num(state, 'y', 0)
  const g = plotPoint(x, y, { maxX, maxY, unit: 26, pad: 34 })
  const origin = plotPoint(0, 0, { maxX, maxY, unit: 26, pad: 34 })

  const cx = Math.max(1, Math.round(maxX))
  const cy = Math.max(1, Math.round(maxY))

  return (
    <svg
      viewBox={`0 0 ${g.width} ${g.height}`}
      className={SVG_CLASS}
      role="img"
      aria-label={`往右 ${Math.round(x)} 格、往上 ${Math.round(y)} 格，点 (${Math.round(x)}, ${Math.round(y)})`}
    >
      {/* 网格 */}
      {Array.from({ length: cx + 1 }, (_, i) => (
        <line
          key={`v${i}`}
          x1={g.pad + i * g.unit}
          y1={g.pad}
          x2={g.pad + i * g.unit}
          y2={g.pad + cy * g.unit}
          stroke={C.rule}
          strokeWidth={1}
        />
      ))}
      {Array.from({ length: cy + 1 }, (_, i) => (
        <line
          key={`h${i}`}
          x1={g.pad}
          y1={g.pad + i * g.unit}
          x2={g.pad + cx * g.unit}
          y2={g.pad + i * g.unit}
          stroke={C.rule}
          strokeWidth={1}
        />
      ))}

      {/* 两条轴 */}
      <line x1={g.pad} y1={origin.py} x2={g.pad + cx * g.unit} y2={origin.py} stroke={C.ink} strokeWidth={2} />
      <line x1={origin.px} y1={g.pad} x2={origin.px} y2={g.pad + cy * g.unit} stroke={C.ink} strokeWidth={2} />
      <text x={g.pad + cx * g.unit} y={origin.py + 16} textAnchor="end" fontSize={11} fill={C.faint}>
        往右
      </text>
      <text x={origin.px - 8} y={g.pad + 4} textAnchor="end" fontSize={11} fill={C.faint}>
        往上
      </text>

      {/* 先横向走、再纵向走：两段虚线就是这条路线 */}
      <line
        x1={origin.px}
        y1={origin.py}
        x2={g.px}
        y2={origin.py}
        stroke={C.beam}
        strokeWidth={2}
        strokeDasharray="5 4"
      />
      <line x1={g.px} y1={origin.py} x2={g.px} y2={g.py} stroke={C.beam} strokeWidth={2} strokeDasharray="5 4" />

      <circle cx={g.px} cy={g.py} r={7} fill={C.beam} />
      <text x={g.px} y={g.py - 14} textAnchor="middle" fontSize={13} fontWeight={700} fill={C.ink}>
        ({Math.round(x)}, {Math.round(y)})
      </text>

      <text x={g.pad + (Math.round(x) * g.unit) / 2} y={origin.py + 18} textAnchor="middle" fontSize={10} fill={C.soft}>
        {Math.round(x)} 格
      </text>
      <text x={g.px + 10} y={origin.py - (Math.round(y) * g.unit) / 2} fontSize={10} fill={C.soft}>
        {Math.round(y)} 格
      </text>
    </svg>
  )
}
