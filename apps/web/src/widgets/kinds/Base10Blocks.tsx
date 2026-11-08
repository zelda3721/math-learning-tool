import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { base10Layout, num } from './layout'

/**
 * 十进制的捆和散：整条 = 10 个一。
 *
 * 位值最容易被教成"十位上的数字表示几个十"这句空话。这里把一条切成 10 格，
 * 再把散块**按 10 个一排**摆好：只要一排满了，就用虚线框起来写上"可以捆成 1 条"。
 * 于是"满十进一"不是一条规定，是孩子自己看出来的。
 */
export function Base10Blocks({ state }: WidgetViewProps) {
  const ones = num(state, 'ones', 0)
  const tens = num(state, 'tens', 0)
  const g = base10Layout(tens, ones)

  const pad = 18
  const rodW = 16
  const rodH = 100
  const rodGap = 8
  const oneSize = 14
  const oneGap = 3
  const perRow = 10

  const rodsWidth = g.rods > 0 ? g.rods * (rodW + rodGap) - rodGap : 0
  const onesRows = Math.ceil(g.ones / perRow)
  const onesWidth = Math.min(g.ones, perRow) * (oneSize + oneGap) - oneGap
  const contentWidth = Math.max(rodsWidth + 76, onesWidth + 96, 180)
  const width = pad * 2 + contentWidth
  const rodsTop = 34
  const onesTop = g.rods > 0 ? rodsTop + rodH + 34 : rodsTop
  const height = onesTop + Math.max(onesRows, 1) * (oneSize + oneGap) + 46

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={SVG_CLASS}
      role="img"
      aria-label={`${g.rods} 条十加 ${g.ones} 个一，一共 ${g.total}`}
    >
      {/* 条：一条就是一个十，里面切出 10 格 */}
      {Array.from({ length: g.rods }, (_, i) => {
        const x = pad + i * (rodW + rodGap)
        return (
          <g key={`rod${i}`}>
            <rect x={x} y={rodsTop} width={rodW} height={rodH} rx={3} fill={C.beamWash} stroke={C.beam} />
            {Array.from({ length: 9 }, (_, k) => (
              <line
                key={k}
                x1={x}
                y1={rodsTop + ((k + 1) * rodH) / 10}
                x2={x + rodW}
                y2={rodsTop + ((k + 1) * rodH) / 10}
                stroke={C.beam}
                strokeWidth={1}
              />
            ))}
          </g>
        )
      })}
      {g.rods > 0 && (
        <text x={pad + rodsWidth + 10} y={rodsTop + rodH / 2} fontSize={12} fill={C.soft}>
          {g.rods} 条 = {g.rods * 10}
        </text>
      )}

      {/* 散块：一排正好 10 个，排满的那排就是"可以捆"的那条 */}
      {Array.from({ length: g.ones }, (_, i) => {
        const row = Math.floor(i / perRow)
        const col = i % perRow
        return (
          <rect
            key={`one${i}`}
            x={pad + col * (oneSize + oneGap)}
            y={onesTop + row * (oneSize + oneGap)}
            width={oneSize}
            height={oneSize}
            rx={2}
            fill={C.correctWash}
            stroke={C.correct}
          />
        )
      })}
      {Array.from({ length: Math.floor(g.ones / perRow) }, (_, row) => (
        <g key={`bundle${row}`}>
          <rect
            x={pad - 4}
            y={onesTop + row * (oneSize + oneGap) - 4}
            width={perRow * (oneSize + oneGap) - oneGap + 8}
            height={oneSize + 8}
            rx={4}
            fill="none"
            stroke={C.correct}
            strokeDasharray="4 3"
          />
          <text
            x={pad + perRow * (oneSize + oneGap) + 4}
            y={onesTop + row * (oneSize + oneGap) + oneSize / 2 + 4}
            fontSize={11}
            fill={C.correct}
          >
            这排能捆成 1 条
          </text>
        </g>
      ))}

      <text x={pad} y={height - 14} fontSize={13} fontWeight={600} fill={C.ink}>
        {g.rods} 条十 + {g.ones} 个一 = {g.total}
        {g.bundles > 0 ? `（${g.bundles * 10} 个一还能捆成 ${g.bundles} 条）` : ''}
      </text>
    </svg>
  )
}
