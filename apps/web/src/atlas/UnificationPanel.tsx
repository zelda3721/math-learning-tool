/**
 * 「题型统一之路」面板（P5，仿 CoveragePanel 折叠样式）：
 * problemTypes 中带 unifiedBy（或旧字段 evolveNote/evolveNode）的题型，按学段分组，
 * 渲染「题型名 →(如何被统一) 统一节点名」；点击节点名派发 mathtutor:atlas-focus
 * 让星图定位——孩子看见：小学的十八般武艺，最终都汇入少数几个高级工具。
 */
import type { Graph, ProblemType, StageId } from './types'

/** server /api/v1/atlas 返回的题型是 schema 归一化后的形态（unifiedBy） */
type UnifiedProblemType = ProblemType & {
    unifiedBy?: { node?: string; note: string }
}

interface UnificationRow {
    id: string
    name: string
    stage: StageId
    note: string
    nodeId: string | undefined
    nodeName: string | undefined
}

interface UnificationPanelProps {
    problemTypes: ProblemType[]
    graph: Graph
}

function focusNode(nodeId: string) {
    window.dispatchEvent(new CustomEvent('mathtutor:atlas-focus', { detail: { nodeId } }))
}

const STAGE_FALLBACK: Record<string, string> = {
    primary: '小学',
    junior: '初中',
    senior: '高中',
    university: '大学·前沿',
}

export function UnificationPanel({ problemTypes, graph }: UnificationPanelProps) {
    const nodeName = new Map(graph.nodes.map((n) => [n.id, n.name]))
    const stageName = (id: string) =>
        graph.stages.find((s) => s.id === id)?.name ?? STAGE_FALLBACK[id] ?? id

    // unifiedBy（server 归一化）优先；本地快照旧字段 evolveNote/evolveNode 兜底
    const rows: UnificationRow[] = (problemTypes as UnifiedProblemType[]).flatMap(
        (p): UnificationRow[] => {
            const uni =
                p.unifiedBy ??
                (p.evolveNote !== undefined ? { node: p.evolveNode, note: p.evolveNote } : undefined)
            if (!uni) return []
            return [
                {
                    id: p.id,
                    name: p.name,
                    stage: p.stage,
                    note: uni.note,
                    nodeId: uni.node,
                    nodeName: uni.node ? (nodeName.get(uni.node) ?? uni.node) : undefined,
                },
            ]
        }
    )

    if (rows.length === 0) {
        return <div className="p-4 text-sm text-slate-400">暂无统一之路数据</div>
    }

    // 按学段分组（保持 graph.stages 顺序）
    const stageOrder = graph.stages.map((s) => s.id as string)
    const byStage = new Map<string, UnificationRow[]>()
    for (const r of rows) {
        const bucket = byStage.get(r.stage)
        if (bucket) bucket.push(r)
        else byStage.set(r.stage, [r])
    }
    const groups = [...byStage.entries()].sort(
        (a, b) => stageOrder.indexOf(a[0]) - stageOrder.indexOf(b[0])
    )

    return (
        <div className="p-4 space-y-4">
            <p className="text-[11px] leading-relaxed text-slate-400">
                这些经典题型不是孤立的技巧——每一个都会在更高学段被更强的工具「统一」。
                点节点名可在星图中定位。
            </p>
            {groups.map(([stage, items]) => (
                <section key={stage}>
                    <h3 className="text-xs font-extrabold tracking-wide text-slate-600 mb-2">
                        {stageName(stage)}（{items.length}）
                    </h3>
                    <ul className="space-y-2">
                        {items.map((r) => (
                            <li
                                key={r.id}
                                className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2"
                            >
                                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                    <span className="font-bold text-slate-700">{r.name}</span>
                                    <span className="text-slate-300">→</span>
                                    {r.nodeId ? (
                                        <button
                                            type="button"
                                            onClick={() => focusNode(r.nodeId!)}
                                            title="在星图中定位"
                                            className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-bold text-indigo-600 hover:bg-indigo-100 transition-colors"
                                        >
                                            {r.nodeName}
                                        </button>
                                    ) : (
                                        <span className="text-slate-400 italic">更高级的统一工具</span>
                                    )}
                                </div>
                                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{r.note}</p>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    )
}
