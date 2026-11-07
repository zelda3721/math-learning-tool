import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { num, numberLineGeometry, paramNum } from './layout'

/**
 * 数轴上的跳：起点 → 箭头 → 落点。
 *
 * 画的是"跳"本身：起点一个实心点、一根带箭头的弧线表示往哪边跳了几格、落点一个空心点。
 * 落点由状态算出来（起点 ± 跳数），所以往左跳时箭头真的会翻过去——
 * 孩子不用读字就知道"减"是往回走。
 */
export function NumberLineJump({ spec, state }: WidgetViewProps) {
  const params = spec.params
  const start = num(state, 'start', 3)
  const jump = num(state, 'jump', 4)
  const right = String(state.direction ?? '向右（加）').includes('右')
  const g = numberLineGeometry({
    start,
    jump,
    right,
    min: paramNum(params, 'min', -10),
    max: paramNum(params, 'max', 20),
    tick: paramNum(params, 'tick', 1),
  })

  const axisY = 104
  const arrowY = 52
  const pad = 34
  const direction = g.endX >= g.startX ? 1 : -1
  const headX = g.startX + direction * 9

  return (
    <svg
      viewBox={`0 0 ${g.width} 150`}
      className={SVG_CLASS}
      role="img"
      aria-label={`从 ${start} 往${right ? '右' : '左'}跳 ${jump} 格，落在 ${g.end}`}
    >
      {/* 轴线与刻度 */}
      <line x1={pad} y1={axisY} x2={g.width - pad} y2={axisY} stroke={C.rule} strokeWidth={2} />
      {g.ticks.map((t) => (
        <g key={t.value}>
          <line x1={t.x} y1={axisY - 5} x2={t.x} y2={axisY + 5} stroke={C.faint} strokeWidth={1.5} />
          {t.label !== null && (
            <text x={t.x} y={axisY + 22} textAnchor="middle" fontSize={11} fill={C.faint}>
              {t.label}
            </text>
          )}
        </g>
      ))}

      {/* 跳跃的箭头：位置和朝向都由落点决定，不是画死的示意图 */}
      {jump > 0 ? (
        <>
          <line x1={g.startX} y1={arrowY} x2={g.endX} y2={arrowY} stroke={C.beam} strokeWidth={2.5} />
          <polygon
            points={`${headX},${arrowY - 6} ${headX},${arrowY + 6} ${g.endX},${arrowY}`}
            fill={C.beam}
          />
          <line x1={g.startX} y1={axisY - 10} x2={g.startX} y2={arrowY + 8} stroke={C.rule} strokeDasharray="3 3" />
          <line x1={g.endX} y1={arrowY + 8} x2={g.endX} y2={axisY - 10} stroke={C.rule} strokeDasharray="3 3" />
          <text
            x={(g.startX + g.endX) / 2}
            y={arrowY - 12}
            textAnchor="middle"
            fontSize={12}
            fontWeight={600}
            fill={C.beam}
          >
            {right ? '+' : '−'}
            {jump}
          </text>
        </>
      ) : (
        <text x={g.startX} y={arrowY - 6} textAnchor="middle" fontSize={12} fill={C.faint}>
          原地不动
        </text>
      )}

      {/* 起点：实心；落点：空心。两个点都在轴上，位置由数值换算 */}
      <circle cx={g.startX} cy={axisY} r={6} fill={C.beam} />
      <text x={g.startX} y={axisY - 14} textAnchor="middle" fontSize={12} fontWeight={700} fill={C.ink}>
        {start}
      </text>
      <circle cx={g.endX} cy={axisY} r={6} fill={C.plate} stroke={C.beam} strokeWidth={2.5} />
      <text x={g.endX} y={axisY + 40} textAnchor="middle" fontSize={12} fontWeight={700} fill={C.ink}>
        落在 {g.end}
      </text>
    </svg>
  )
}
