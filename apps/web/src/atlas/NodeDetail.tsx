// 节点详情浮层（精简版）：name / summary / 前置 chips / 演化 chips
// chip 点击 → 跳转选中对应节点
// P1b：status 徽章（未核验/已核验）+「标记已核验」入口 + 命中题数
import { useState, type CSSProperties } from 'react'
import { Badge, Button } from '../ui'
import type { GraphIndex } from './graphIndex'
import type { KnowledgeNode } from './types'
import { verifyNodeApi } from './CoveragePanel'

interface NodeDetailProps {
    gi: GraphIndex
    id: string
    onJump: (id: string) => void
    onClose: () => void
    /** 该节点命中题数（AtlasPage 从 coverage 传入；缺省不显示） */
    questionCount?: number
    /** 父级已知的核验覆写（本会话内刚核验过的节点） */
    verified?: boolean
    /** 核验成功回调（父级同步 coverage / 覆写集合） */
    onVerified?: (id: string) => void
    /**
     * 这个知识点涵盖的题型。
     *
     * 星图上的星是**知识点**（大纲的骨架），题型不单独成星——
     * 它是知识点在具体情境下的变体：「年龄问题」不是一个知识点，
     * 它是「100以内加减法」加上「年龄差不变」这个情境。
     * 所以题型挂在知识点下面：点开一颗星，才看得到它管着哪几类题。
     */
    problemTypes?: { id: string; name: string; essence?: string }[]
}

const chipStyle = (color: string) => ({ '--c': color }) as CSSProperties

export function NodeDetail({
    gi,
    id,
    onJump,
    onClose,
    questionCount,
    verified,
    onVerified,
    problemTypes,
}: NodeDetailProps) {
    // 本地核验状态：按钮成功后立即翻徽章（父级 verified 覆写用于跨开合保持）
    const [localVerified, setLocalVerified] = useState(false)
    const [verifying, setVerifying] = useState(false)
    const [verifyError, setVerifyError] = useState<string | null>(null)

    const node = gi.getNode(id)
    if (!node) return null

    const isVerified = localVerified || verified || node.status === 'verified'

    const markVerified = async () => {
        setVerifying(true)
        setVerifyError(null)
        const res = await verifyNodeApi(id)
        setVerifying(false)
        if (res.ok) {
            setLocalVerified(true)
            onVerified?.(id)
        } else {
            setVerifyError(res.error ?? '核验失败')
        }
    }

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
            className="plate absolute top-3 right-3 bottom-3 z-20 w-[340px] max-w-[86%] overflow-y-auto p-5"
            aria-label={`${node.name} 详情`}
        >
            <button
                type="button"
                onClick={onClose}
                aria-label="关闭详情"
                className="absolute top-3 right-3 w-8 h-8 rounded-[10px] bg-paper text-ink-faint hover:bg-wrong-wash hover:text-wrong transition-colors"
            >
                ✕
            </button>

            <div className="flex flex-wrap items-center gap-1.5 mb-2 pr-8">
                {stage && (
                    <span
                        className="text-[11px] font-bold text-white px-2 py-0.5 rounded-md"
                        style={{ background: stage.accent }}
                    >
                        {stage.name}
                    </span>
                )}
                {strand && (
                    <span
                        className="text-[11px] font-bold text-white px-2 py-0.5 rounded-md"
                        style={{ background: strand.color }}
                    >
                        {strand.icon} {strand.name}
                    </span>
                )}
                {isVerified ? (
                    <Badge tone="correct">✓ 已核验</Badge>
                ) : (
                    <Badge tone="slate">未核验</Badge>
                )}
            </div>

            <h2 className="text-xl font-bold text-ink leading-tight tracking-tight">
                {node.name}
                {node.nameEn && (
                    <span className="ml-2 text-xs font-medium text-ink-faint">{node.nameEn}</span>
                )}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{node.summary}</p>

            {(questionCount !== undefined || !isVerified) && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    {questionCount !== undefined && (
                        <span className="text-xs text-ink-faint">
                            命中题目 <b className="numeric text-ink">{questionCount}</b> 道
                        </span>
                    )}
                    {!isVerified && (
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={verifying}
                            onClick={() => void markVerified()}
                        >
                            {verifying ? '提交中…' : '标记已核验'}
                        </Button>
                    )}
                    {verifyError && <span className="text-[11px] text-wrong">{verifyError}</span>}
                </div>
            )}

            {prereqs.length > 0 && (
                <section className="mt-4">
                    <h3 className="eyebrow mb-2">前置知识</h3>
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

            {problemTypes && problemTypes.length > 0 && (
                <section className="mt-4">
                    <h3 className="eyebrow mb-2">
                        这个知识点管着这几类题
                    </h3>
                    <ul className="space-y-2">
                        {problemTypes.map((t) => (
                            <li key={t.id} className="rounded-[8px] bg-paper px-3 py-2">
                                <p className="text-sm font-semibold text-ink">{t.name}</p>
                                {/* 本质那句才是这类题唯一要讲的东西：
                                    「年龄差永远不变」比十道年龄题都管用 */}
                                {t.essence && (
                                    <p className="mt-0.5 text-xs leading-relaxed text-ink-soft">{t.essence}</p>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {evolves.length > 0 && (
                <section className="mt-4">
                    <h3 className="eyebrow mb-2">演化方向</h3>
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
                        <p className="mt-2 text-xs leading-relaxed text-ink-soft">{evolves[0].how}</p>
                    )}
                </section>
            )}
        </aside>
    )
}
