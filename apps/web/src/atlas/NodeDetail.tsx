// 节点详情浮层（精简版）：name / summary / 前置 chips / 演化 chips
// chip 点击 → 跳转选中对应节点
import type { CSSProperties } from 'react'
import type { GraphIndex } from './graphIndex'
import type { KnowledgeNode } from './types'

interface NodeDetailProps {
    gi: GraphIndex
    id: string
    onJump: (id: string) => void
    onClose: () => void
}

const chipStyle = (color: string) => ({ '--c': color }) as CSSProperties

export function NodeDetail({ gi, id, onJump, onClose }: NodeDetailProps) {
    const node = gi.getNode(id)
    if (!node) return null

    const stage = gi.stageById.get(node.stage)
    const strand = gi.strandById.get(node.strand)
    const prereqs = node.prerequisites
        .map((p) => gi.getNode(p))
        .filter((n): n is KnowledgeNode => Boolean(n))
    const evolves = node.evolvesTo
        .map((e) => ({ how: e.how, target: gi.getNode(e.to) }))
        .filter((e): e is { how: string; target: KnowledgeNode } => Boolean(e.target))

    const colorOf = (n: KnowledgeNode) => gi.strandById.get(n.strand)?.color ?? '#64748b'

    return (
        <aside
            className="absolute top-3 right-3 bottom-3 z-20 w-[340px] max-w-[86%] overflow-y-auto rounded-2xl bg-white/95 backdrop-blur border border-slate-200 shadow-xl p-5"
            aria-label={`${node.name} 详情`}
        >
            <button
                type="button"
                onClick={onClose}
                aria-label="关闭详情"
                className="absolute top-3 right-3 w-8 h-8 rounded-full bg-slate-100 text-slate-500 hover:bg-red-50 hover:text-red-500 transition-colors"
            >
                ✕
            </button>

            <div className="flex flex-wrap gap-1.5 mb-2 pr-8">
                {stage && (
                    <span
                        className="text-[11px] font-bold text-white px-2.5 py-0.5 rounded-full"
                        style={{ background: stage.accent }}
                    >
                        {stage.name}
                    </span>
                )}
                {strand && (
                    <span
                        className="text-[11px] font-bold text-white px-2.5 py-0.5 rounded-full"
                        style={{ background: strand.color }}
                    >
                        {strand.icon} {strand.name}
                    </span>
                )}
            </div>

            <h2 className="text-xl font-extrabold text-slate-800 leading-tight">
                {node.name}
                {node.nameEn && (
                    <span className="ml-2 text-xs font-medium text-slate-400">{node.nameEn}</span>
                )}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">{node.summary}</p>

            {prereqs.length > 0 && (
                <section className="mt-4">
                    <h3 className="text-xs font-extrabold tracking-wide text-slate-600 mb-2">
                        前置知识
                    </h3>
                    <div className="chips">
                        {prereqs.map((p) => (
                            <button
                                type="button"
                                key={p.id}
                                className="chip"
                                style={chipStyle(colorOf(p))}
                                onClick={() => onJump(p.id)}
                            >
                                <span className="chip-dot" style={{ background: colorOf(p) }} />
                                {p.name}
                            </button>
                        ))}
                    </div>
                </section>
            )}

            {evolves.length > 0 && (
                <section className="mt-4">
                    <h3 className="text-xs font-extrabold tracking-wide text-slate-600 mb-2">
                        演化方向
                    </h3>
                    <div className="chips">
                        {evolves.map((e) => (
                            <button
                                type="button"
                                key={e.target.id}
                                className="chip"
                                style={chipStyle(colorOf(e.target))}
                                title={e.how || undefined}
                                onClick={() => onJump(e.target.id)}
                            >
                                <span className="chip-dot" style={{ background: colorOf(e.target) }} />
                                {e.target.name} ↗
                            </button>
                        ))}
                    </div>
                    {evolves[0]?.how && (
                        <p className="mt-2 text-xs leading-relaxed text-violet-700/80">
                            {evolves[0].how}
                        </p>
                    )}
                </section>
            )}
        </aside>
    )
}
