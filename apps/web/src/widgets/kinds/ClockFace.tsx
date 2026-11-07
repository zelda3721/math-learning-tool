import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { clockHandAngles, num } from './layout'

/**
 * 钟面：时针、分针、以及分针走过的那段弧。
 *
 * 关键在于**两根针一起动**：拨到 3:30 时如果时针还死死指着 3，孩子学到的就是错的。
 * 时针的角度里含了 minute/60，所以分针走半圈时针正好走半格——
 * "分针一圈 = 时针一大格"这句话在画面上能直接看出来。
 */
export function ClockFace({ state }: WidgetViewProps) {
  const hour = num(state, 'hour', 8)
  const minute = num(state, 'minute', 0)
  const { hourAngle, minuteAngle } = clockHandAngles(hour, minute)

  const cx = 130
  const cy = 130
  const r = 100
  const h = ((Math.round(hour) % 24) + 24) % 24
  const m = Math.min(59, Math.max(0, Math.round(minute)))
  const digital = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

  // 分针扫过的弧：从 12 点方向顺时针到分针，半径略微收在刻度内
  const arcR = r - 12
  const rad = ((minuteAngle - 90) * Math.PI) / 180
  const arcEnd = { x: cx + arcR * Math.cos(rad), y: cy + arcR * Math.sin(rad) }
  const largeArc = minuteAngle > 180 ? 1 : 0

  return (
    <svg viewBox="0 0 260 288" className={SVG_CLASS} role="img" aria-label={`钟面 ${digital}`}>
      <circle cx={cx} cy={cy} r={r} fill={C.plate} stroke={C.rule} strokeWidth={3} />

      {/* 12 个刻度与数字 */}
      {Array.from({ length: 12 }, (_, i) => {
        const angle = i * 30
        const a = ((angle - 90) * Math.PI) / 180
        const inner = { x: cx + (r - 10) * Math.cos(a), y: cy + (r - 10) * Math.sin(a) }
        const outer = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
        const numPos = { x: cx + (r - 26) * Math.cos(a), y: cy + (r - 26) * Math.sin(a) }
        return (
          <g key={i}>
            <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke={C.faint} strokeWidth={2} />
            <text x={numPos.x} y={numPos.y + 4} textAnchor="middle" fontSize={12} fill={C.soft}>
              {i === 0 ? 12 : i}
            </text>
          </g>
        )
      })}

      {/* 分针走过的弧：走过多少分钟，弧就有多长 */}
      {minuteAngle > 0 && (
        <path
          d={`M ${cx} ${cy - arcR} A ${arcR} ${arcR} 0 ${largeArc} 1 ${arcEnd.x} ${arcEnd.y}`}
          fill="none"
          stroke={C.beamWash}
          strokeWidth={8}
        />
      )}

      {/* 时针：含分针带来的那一点偏移，慢而真的走 */}
      <line
        x1={cx}
        y1={cy}
        x2={cx}
        y2={cy - (r - 46)}
        stroke={C.ink}
        strokeWidth={7}
        strokeLinecap="round"
        transform={`rotate(${hourAngle} ${cx} ${cy})`}
      />
      {/* 分针 */}
      <line
        x1={cx}
        y1={cy}
        x2={cx}
        y2={cy - (r - 18)}
        stroke={C.beam}
        strokeWidth={4.5}
        strokeLinecap="round"
        transform={`rotate(${minuteAngle} ${cx} ${cy})`}
      />
      <circle cx={cx} cy={cy} r={6} fill={C.ink} />

      <text x={cx} y={270} textAnchor="middle" fontSize={18} fontWeight={700} fill={C.ink}>
        {digital}
      </text>
    </svg>
  )
}
