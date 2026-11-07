import { C, SVG_CLASS, type WidgetViewProps } from './palette'
import { changeLayout, num, paramNum } from './layout'

/**
 * 找零：价格和付的钱画成两根共用标尺的条，差出来的那一段就是找零。
 *
 * 两根条**必须共用一个标尺**：各按各的比例画，2 元和 50 元会一样长，
 * 长度差就成了假的。共用之后，"多付的部分"才真的是屏幕上多出来的那一截。
 * 付少了不假装有找零，而是把缺的那一截涂红——差额是同一件事的两面。
 */
export function MoneyChange({ spec, state }: WidgetViewProps) {
  const currency = String(spec.params.currency ?? '元')
  const price = num(state, 'price', 8)
  const paid = num(state, 'paid', 10)
  const layout = changeLayout(price, paid, paramNum(spec.params, 'maxPrice', 50))

  const x0 = 50
  const maxW = 320
  const barH = 28
  const priceY = 46
  const paidY = 100
  const priceW = Math.max(layout.price > 0 ? 3 : 0, layout.priceRatio * maxW)
  const paidW = Math.max(layout.paid > 0 ? 3 : 0, layout.paidRatio * maxW)
  const diffW = layout.changeRatio * maxW

  const priceLabel = `${layout.price} ${currency}`
  const paidLabel = `${layout.paid} ${currency}`

  return (
    <svg
      viewBox="0 0 460 196"
      className={SVG_CLASS}
      role="img"
      aria-label={
        layout.enough
          ? `价格 ${layout.price}，付了 ${layout.paid}，应找 ${layout.change}`
          : `付了 ${layout.paid}，比价格 ${layout.price} 还少 ${layout.short}`
      }
    >
      <text x={16} y={priceY + barH / 2 + 5} fontSize={12} fill={C.soft}>
        价格
      </text>
      <rect x={x0} y={priceY} width={priceW} height={barH} rx={4} fill={C.beam} />
      <text x={x0 + priceW + 8} y={priceY + barH / 2 + 5} fontSize={12} fontWeight={600} fill={C.ink}>
        {priceLabel}
      </text>

      <text x={16} y={paidY + barH / 2 + 5} fontSize={12} fill={C.soft}>
        付了
      </text>
      <rect x={x0} y={paidY} width={paidW} height={barH} rx={4} fill={C.soft} />
      <text x={x0 + paidW + 8} y={paidY + barH / 2 + 5} fontSize={12} fontWeight={600} fill={C.ink}>
        {paidLabel}
      </text>

      {/* 差额那一段：够就是绿色的找零，不够就是红色的缺口 */}
      {layout.enough ? (
        layout.change > 0 ? (
          <g>
            <rect x={x0 + priceW} y={paidY} width={diffW} height={barH} rx={4} fill={C.correct} />
            <line
              x1={x0 + paidW}
              y1={paidY - 10}
              x2={x0 + priceW}
              y2={paidY - 10}
              stroke={C.correct}
              strokeWidth={2}
            />
            <text
              x={x0 + priceW + diffW / 2}
              y={paidY - 16}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill={C.correct}
            >
              找零 {layout.change} {currency}
            </text>
          </g>
        ) : null
      ) : (
        <g>
          <rect x={x0 + paidW} y={priceY} width={diffW} height={barH} fill={C.wrongWash} stroke={C.wrong} strokeDasharray="4 3" />
          <text
            x={x0 + paidW + diffW / 2}
            y={priceY - 8}
            textAnchor="middle"
            fontSize={11}
            fontWeight={600}
            fill={C.wrong}
          >
            还差 {layout.short} {currency}
          </text>
        </g>
      )}

      {/* 便宜的时候价格条可能比数字还短，数字补在旁边算兜底，但条长仍按真实比例 */}
      <text x={16} y={176} fontSize={13} fontWeight={600} fill={C.ink}>
        {layout.enough
          ? `找零 = 付的 ${layout.paid} − 价格 ${layout.price} = ${layout.change} ${currency}`
          : `付的 ${layout.paid} 比价格 ${layout.price} 少 ${layout.short} ${currency}，没得找`}
      </text>
    </svg>
  )
}
