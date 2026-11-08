import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { gridLayout, num } from './layout'

/**
 * 铺满它：长 × 宽 个方格铺成的长方形。
 *
 * 面积为什么是"乘"：每行铺 w 个、铺 h 行，格子数就是 w 行累加。
 * 所以画面上要把**行**画出来（隔行换底色 + 左侧行号），孩子就能一层层数；
 * 只画一个长方形填色的话，"乘"这件事就被藏掉了。
 */
export function AreaGrid({ state }: WidgetViewProps) {
  const width = num(state, 'width', 4)
  const height = num(state, 'height', 3)
  const g = gridLayout(width, height, 34, 18)

  return (
    <svg
      viewBox={`0 0 ${Math.max(g.width + 46, 200)} ${Math.max(g.height + 44, 120)}`}
      className={SVG_CLASS}
      role="img"
      aria-label={`长 ${g.cols}、宽 ${g.rows}，一共 ${g.count} 个小方格`}
    >
      {g.cells.map((cell) => (
        <rect
          key={`${cell.row}-${cell.col}`}
          x={cell.x}
          y={cell.y}
          width={g.cell}
          height={g.cell}
          // 行与行交替底色：一行的边界看得见，"有几行"才数得出来
          fill={cell.row % 2 === 0 ? C.beamWash : C.plate}
          stroke={C.beam}
          strokeWidth={1}
        />
      ))}

      {/* 第一行标出来：每行放几个 */}
      <line
        x1={g.pad}
        y1={g.pad - 8}
        x2={g.pad + g.cols * g.cell}
        y2={g.pad - 8}
        stroke={C.beam}
        strokeWidth={2}
      />
      <text x={g.pad + (g.cols * g.cell) / 2} y={g.pad - 13} textAnchor="middle" fontSize={12} fill={C.beam}>
        每行 {g.cols} 个
      </text>

      {/* 行号：数行用 */}
      {Array.from({ length: g.rows }, (_, row) => (
        <text
          key={`r${row}`}
          x={g.pad - 8}
          y={g.pad + row * g.cell + g.cell / 2 + 4}
          textAnchor="end"
          fontSize={10}
          fill={C.faint}
        >
          {row + 1}
        </text>
      ))}

      <text x={g.pad} y={g.height + 24} fontSize={13} fontWeight={600} fill={C.ink}>
        {g.cols} 个一行 × {g.rows} 行 = {g.count} 个格子
      </text>
    </svg>
  )
}
