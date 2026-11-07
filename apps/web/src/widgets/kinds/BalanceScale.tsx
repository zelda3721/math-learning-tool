import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { balanceTilt, beamEnds, num, paramNum, type Pt } from './layout'

/**
 * 天平：横梁按两边的差倾斜，托盘跟着横梁两端走。
 *
 * 平衡是一条**比例关系**：差得多就歪得多，差 0 才平。所以倾角由差值算出，
 * 托盘位置由倾角算出——两级都是算出来的，画面上"哪边重"不用文字解释。
 * 砝码画成一个个小方块（不是直接写数字）：块多的那边看得见地往下坠。
 */
export function BalanceScale({ spec, state }: WidgetViewProps) {
  const max = paramNum(spec.params, 'maxWeight', 20)
  const left = num(state, 'left', 5)
  const right = num(state, 'right', 3)
  const tilt = balanceTilt(left, right, max)
  const pivot: Pt = { x: 230, y: 52 }
  const halfLen = 140
  const ends = beamEnds(tilt, halfLen, pivot)

  return (
    <svg
      viewBox="0 0 460 224"
      className={SVG_CLASS}
      role="img"
      aria-label={
        left === right
          ? `两边都是 ${left}，天平是平的`
          : `左边 ${left}、右边 ${right}，${left > right ? '左' : '右'}边重 ${Math.abs(left - right)}`
      }
    >
      {/* 支架 */}
      <line x1={pivot.x} y1={pivot.y} x2={pivot.x} y2={176} stroke={C.soft} strokeWidth={5} />
      <polygon points={`${pivot.x - 34},176 ${pivot.x + 34},176 ${pivot.x},162`} fill={C.soft} />
      <circle cx={pivot.x} cy={pivot.y} r={6} fill={C.plate} stroke={C.soft} strokeWidth={3} />

      {/* 横梁：绕支点转过后画出来 */}
      <line
        x1={ends.left.x}
        y1={ends.left.y}
        x2={ends.right.x}
        y2={ends.right.y}
        stroke={C.ink}
        strokeWidth={4}
        strokeLinecap="round"
      />

      <Pan at={ends.left} weight={left} label="左" />
      <Pan at={ends.right} weight={right} label="右" />

      <text x={230} y={210} textAnchor="middle" fontSize={13} fontWeight={600} fill={C.soft}>
        {left === right ? `两边都是 ${left}，平的` : `${left > right ? '左' : '右'}边重 ${Math.abs(left - right)}`}
      </text>
    </svg>
  )
}

/** 一个托盘：吊杆 + 盘面 + 里面按个数摆出来的砝码 */
function Pan({ at, weight, label }: { at: Pt; weight: number; label: string }) {
  const rodLen = 30
  const panWidth = 96
  const panTop = at.y + rodLen
  const count = Math.min(20, Math.max(0, Math.round(weight)))
  const perRow = 5
  const size = 9
  const gap = 2

  return (
    <g>
      <line x1={at.x} y1={at.y} x2={at.x} y2={panTop} stroke={C.soft} strokeWidth={2} />
      <line x1={at.x - panWidth / 2} y1={panTop} x2={at.x + panWidth / 2} y2={panTop} stroke={C.ink} strokeWidth={3} />
      <path
        d={`M ${at.x - panWidth / 2} ${panTop} Q ${at.x} ${panTop + 22} ${at.x + panWidth / 2} ${panTop}`}
        fill="none"
        stroke={C.ink}
        strokeWidth={2}
      />

      {/* 砝码：一块一个，摆在盘子里。块数一眼可数，才比得出哪边重 */}
      {Array.from({ length: count }, (_, i) => {
        const row = Math.floor(i / perRow)
        const col = i % perRow
        const rowCount = Math.min(perRow, count - row * perRow)
        const rowWidth = rowCount * (size + gap) - gap
        return (
          <rect
            key={i}
            x={at.x - rowWidth / 2 + col * (size + gap)}
            y={panTop + 6 + row * (size + gap)}
            width={size}
            height={size}
            rx={2}
            fill={C.beam}
          />
        )
      })}

      <text x={at.x} y={panTop + 70} textAnchor="middle" fontSize={12} fill={C.soft}>
        {label} {count}
      </text>
    </g>
  )
}
