import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { fractionSegments, num } from './layout'

/**
 * 分数条：一条被分成 d 份，涂了 n 份。
 *
 * 分母不是数字而是"看得见的份数"——这正是分数的难点：孩子常常把 1/4 读成
 * "一大块里的一小块"，看他亲手把同一条切成 4 份、涂上 1 份，才知道 4 说的是份数。
 * 涂满所有份时整条变成一条满色，1 = 全部 这件事就不言自明。
 */
export function FractionBar({ state }: WidgetViewProps) {
  const denominator = num(state, 'denominator', 4)
  const numerator = num(state, 'numerator', 1)
  const segments = fractionSegments(denominator, numerator)
  const barY = 34
  const barH = 64
  const d = Math.max(1, Math.round(denominator))
  const n = Math.min(d, Math.max(0, Math.round(numerator)))
  const full = n === d && d > 0
  const percent = d > 0 ? Math.round((n / d) * 100) : 0

  return (
    <svg
      viewBox="0 0 460 168"
      className={SVG_CLASS}
      role="img"
      aria-label={`分成 ${d} 份，涂了 ${n} 份，也就是 ${n}/${d}`}
    >
      {segments.map((s) => (
        <rect
          key={s.index}
          x={s.x}
          y={barY}
          width={s.width}
          height={barH}
          rx={4}
          fill={s.filled ? C.beam : C.plate}
          stroke={s.filled ? C.beam : C.rule}
          strokeWidth={1.5}
        />
      ))}

      {/* 每份的序号写在下方：一眼数得出"分成几份" */}
      {segments.map((s) => (
        <text
          key={`n${s.index}`}
          x={s.x + s.width / 2}
          y={barY + barH + 16}
          textAnchor="middle"
          fontSize={10}
          fill={C.faint}
        >
          {s.index + 1}
        </text>
      ))}

      <text x={30} y={barY + barH + 48} fontSize={16} fontWeight={700} fill={C.ink}>
        {n} / {d}
      </text>
      <text x={118} y={barY + barH + 48} fontSize={12} fill={C.soft}>
        {full ? '涂满了，正好是整个 1' : `涂了 ${percent}%`}
      </text>
      <text x={430} y={barY + barH + 48} textAnchor="end" fontSize={12} fill={C.faint}>
        一条 = {d} 份
      </text>
    </svg>
  )
}
