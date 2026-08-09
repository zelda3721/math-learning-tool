// 移植自 math-wiki src/layout.ts（原样拷入，仅类型导入路径不变）
import type { Graph, KnowledgeNode, StageId, StrandId } from './types'

export interface NodeBox {
  node: KnowledgeNode
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
}
export interface StageBand {
  id: StageId
  name: string
  accent: string
  x: number
  w: number
}
export interface StrandBand {
  id: StrandId
  name: string
  color: string
  icon: string
  y: number
  h: number
}
export interface Layout {
  boxes: Map<string, NodeBox>
  stageBands: StageBand[]
  strandBands: StrandBand[]
  width: number
  height: number
}

// 布局常量：四条主线各占一行，节点放大、横向紧凑
const PAD_L = 240 // 左侧主线标签留白（首列节点左边缘需让出标签区）
const PAD_T = 110 // 顶部留白：给最上一行的"如何演化/由来"标签让出位置（在学段标题之下、首行节点之上）
const PAD_R = 70
const PAD_B = 44
const COL_STEP = 210 // 同一行内相邻节点的水平间距（留出连线与标签的空间）
const STAGE_GAP = 58 // 学段之间额外间隔
const ROW_STEP = 140 // 主线行高（单行）
const STRAND_GAP = 56 // 主线行之间间隔：加宽成"标签车道"，让关系/演化标签有干净的落位带
const NODE_W = 170
const NODE_H = 74

const keyOf = (st: string, sd: string) => `${st}|${sd}`

/**
 * 进化树布局（"四条河流"版）：
 *   纵轴 = 4 条主线，各一行
 *   横轴 = 学段(列块) + 学段内左对齐的紧凑排列；从左到右就是演化方向
 * 紧凑、无空列，节点大、可铺满竖直方向。
 */
export function computeLayout(graph: Graph): Layout {
  const { nodes, stages, strands } = graph

  // 按 (学段,主线) 分组并按 order/lane 排序
  const groups = new Map<string, KnowledgeNode[]>()
  for (const n of nodes) {
    const k = keyOf(n.stage, n.strand)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(n)
  }
  for (const arr of groups.values()) arr.sort((a, b) => a.order - b.order || a.lane - b.lane)

  // 每个学段的列数 = 该学段中最"忙"主线的节点数
  const stageCols = new Map<StageId, number>()
  for (const st of stages) {
    let max = 1
    for (const sd of strands) max = Math.max(max, groups.get(keyOf(st.id, sd.id))?.length ?? 0)
    stageCols.set(st.id, max)
  }

  // 学段水平起点
  const stageStartX = new Map<StageId, number>()
  const stageBands: StageBand[] = []
  let cursorX = PAD_L
  for (const st of stages) {
    const cols = stageCols.get(st.id)!
    const w = cols * COL_STEP
    stageStartX.set(st.id, cursorX)
    stageBands.push({ id: st.id, name: st.name, accent: st.accent, x: cursorX - COL_STEP / 2, w: w + STAGE_GAP / 2 })
    cursorX += w + STAGE_GAP
  }
  const width = cursorX - STAGE_GAP + PAD_R

  // 每条主线一行
  const strandCenterY = new Map<StrandId, number>()
  const strandBands: StrandBand[] = []
  let cursorY = PAD_T
  for (const sd of strands) {
    strandCenterY.set(sd.id, cursorY + ROW_STEP / 2)
    strandBands.push({ id: sd.id, name: sd.name, color: sd.color, icon: sd.icon, y: cursorY, h: ROW_STEP })
    cursorY += ROW_STEP + STRAND_GAP
  }
  const height = cursorY - STRAND_GAP + PAD_B

  // 放置节点：每个 (学段,主线) 在该学段起点处左对齐紧凑排列
  const boxes = new Map<string, NodeBox>()
  for (const st of stages) {
    for (const sd of strands) {
      const arr = groups.get(keyOf(st.id, sd.id)) ?? []
      arr.forEach((n, i) => {
        const x = stageStartX.get(st.id)! + i * COL_STEP
        const y = strandCenterY.get(sd.id)!
        boxes.set(n.id, { node: n, x: x - NODE_W / 2, y: y - NODE_H / 2, w: NODE_W, h: NODE_H, cx: x, cy: y })
      })
    }
  }

  return { boxes, stageBands, strandBands, width, height }
}
