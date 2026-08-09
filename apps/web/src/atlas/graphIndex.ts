// 移植自 math-wiki src/graph.ts —— 最小适配：
//  - 模块级单例改为工厂 createGraphIndex(graph)，数据经参数注入
//  - 只保留 TreeCanvas / 详情浮层所需的索引与 evolutionPath 等函数
// 说明：@mathtutor/knowledge 已有同语义实现；为减少适配风险，atlas/ 内
// 自带这份从 wiki 原样拷的最小实现（P0 后可切换到共享包）。
import type { Graph, KnowledgeNode, Stage, StageId, Strand, StrandId } from './types'

export interface EvolutionSeg {
  from: string
  to: string
  how: string
}

const stageRank: Record<StageId, number> = { primary: 0, junior: 1, senior: 2, university: 3 }

export function createGraphIndex(graph: Graph) {
  const { nodes, stages, strands } = graph

  const nodeById = new Map<string, KnowledgeNode>(nodes.map((n) => [n.id, n]))
  const stageById = new Map<StageId, Stage>(stages.map((s) => [s.id, s]))
  const strandById = new Map<StrandId, Strand>(strands.map((s) => [s.id, s]))
  const getNode = (id: string | null | undefined) => (id ? nodeById.get(id) : undefined)

  // 反向「演化自」索引：谁演化成了我
  const reverseEvolve = new Map<string, string[]>()
  for (const n of nodes) {
    for (const e of n.evolvesTo) {
      if (!nodeById.has(e.to)) continue
      if (!reverseEvolve.has(e.to)) reverseEvolve.set(e.to, [])
      reverseEvolve.get(e.to)!.push(n.id)
    }
  }
  const evolvedFrom = (id: string) => reverseEvolve.get(id) ?? []

  /** 后续演化：沿 evolvesTo 可达的全部节点（不含自身） */
  function descendants(id: string): Set<string> {
    const seen = new Set<string>()
    const stack = [...(getNode(id)?.evolvesTo ?? []).map((e) => e.to)]
    while (stack.length) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const e of getNode(cur)?.evolvesTo ?? []) stack.push(e.to)
    }
    return seen
  }

  const isFrontier = (n: KnowledgeNode) =>
    n.stage === 'university' || n.applications.some((a) => a.frontier)

  /**
   * 一条「演化主路径」：从该节点沿 evolvesTo 一路走到最远（优先抵达前沿）。
   * 返回 [{from, to, how}...] 的链条，用于「演化光路」。
   */
  function evolutionPath(id: string): EvolutionSeg[] {
    const path: EvolutionSeg[] = []
    const visited = new Set<string>([id])
    let cur = id
    // 贪心：每步选择「能到达最高学段 / 前沿」的后继
    for (let guard = 0; guard < 12; guard++) {
      const links = (getNode(cur)?.evolvesTo ?? []).filter((e) => nodeById.has(e.to) && !visited.has(e.to))
      if (!links.length) break
      links.sort((a, b) => {
        const na = getNode(a.to)!
        const nb = getNode(b.to)!
        const fa = (isFrontier(na) ? 10 : 0) + descendants(a.to).size + stageRank[na.stage]
        const fb = (isFrontier(nb) ? 10 : 0) + descendants(b.to).size + stageRank[nb.stage]
        return fb - fa
      })
      const next = links[0]
      path.push({ from: cur, to: next.to, how: next.how })
      visited.add(next.to)
      cur = next.to
    }
    return path
  }

  return { graph, nodeById, stageById, strandById, getNode, evolvedFrom, descendants, evolutionPath }
}

export type GraphIndex = ReturnType<typeof createGraphIndex>
