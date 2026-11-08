import { useCallback, useEffect, useState } from 'react'

import { ErrorState, LoadingState } from '../ui'

/**
 * 家长端：前测 → 后测 → 保持率。
 *
 * 这张表是 V1.0 里唯一能回答"学了有没有用"的东西，所以它只放可核对的东西：
 * 每档做了几道、对了几道，前后两档在**同一批节点**上的变化。
 * 不做加权、不折算成分数——那是另一套需要单独论证的口径。
 */

interface Session {
    id: string
    kind: 'pre' | 'post' | 'retention'
    answered: number
    total: number
    correct: number
    rate: number | null
}

interface Comparison {
    before: string
    after: string
    nodes: { nodeId: string; beforeRate: number; afterRate: number; delta: number }[]
    overall: { beforeRate: number | null; afterRate: number | null }
}

interface Report {
    sessions: Session[]
    preToPost: Comparison | null
    postToRetention: Comparison | null
    next: { kind: string; why: string; dueAt?: string } | null
}

const KIND_LABEL: Record<string, string> = { pre: '前测', post: '后测', retention: '保持率' }

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

export function AssessmentPanel({ learnerId }: { learnerId: string }) {
    const [report, setReport] = useState<Report | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            const res = await fetch(`/api/v1/parent/assessments?learnerId=${encodeURIComponent(learnerId)}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setReport((await res.json()) as Report)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        setReport(null)
        void load()
    }, [load])

    if (error) return <ErrorState message={`测评数据加载失败：${error}`} onRetry={() => void load()} />
    if (!report) return <LoadingState text="正在取测评记录……" />

    return (
        <section className="plate p-6 space-y-3">
            <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-ink">阶段测评</h2>
                <span className="text-xs text-ink-faint">{report.sessions.length} 份</span>
            </div>

            {report.sessions.length === 0 ? (
                <p className="text-sm text-ink-faint">
                    还没有做过测评。孩子在练习页会看到「前测」的入口——做完它，之后才说得清学到了什么。
                </p>
            ) : (
                <ul className="space-y-2">
                    {report.sessions.map((s) => (
                        <li key={s.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-rule bg-plate px-3 py-2 text-sm">
                            <span className="font-semibold text-ink">{KIND_LABEL[s.kind] ?? s.kind}</span>
                            <span className="text-ink-faint numeric">
                                {s.answered}/{s.total} 道 · 对 {s.correct} · {pct(s.rate)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {report.preToPost && (
                <ComparisonRow title="前测 → 后测" cmp={report.preToPost} />
            )}
            {report.postToRetention && (
                <ComparisonRow title="后测 → 保持率" cmp={report.postToRetention} />
            )}

            {report.next && (
                <p className="text-xs text-ink-faint">
                    下一份：{KIND_LABEL[report.next.kind] ?? report.next.kind}
                    {report.next.dueAt
                        ? `（${report.next.dueAt.slice(0, 10)} 之后可以让孩子做）`
                        : '——现在就可以做'}
                </p>
            )}
            <p className="text-xs text-ink-faint">
                测评单独记账，不算进掌握度：它测的是会不会，不是练了多少。
            </p>
        </section>
    )
}

function ComparisonRow({ title, cmp }: { title: string; cmp: Comparison }) {
    const changed = cmp.nodes.filter((n) => Math.abs(n.delta) > 0.001)
    return (
        <div className="rounded-[10px] border border-rule bg-plate px-3 py-2 space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-semibold text-ink">{title}</span>
                <span className="text-ink-faint numeric">
                    {pct(cmp.overall.beforeRate)} → {pct(cmp.overall.afterRate)}
                </span>
            </div>
            {changed.length === 0 ? (
                <p className="text-xs text-ink-faint">两次覆盖的节点上，正确率没有变化。</p>
            ) : (
                <ul className="space-y-0.5">
                    {changed.slice(0, 8).map((n) => (
                        <li key={n.nodeId} className="flex items-center justify-between gap-2 text-xs text-ink-soft">
                            <span className="truncate">{n.nodeId}</span>
                            <span className={`numeric ${n.delta > 0 ? 'text-[color:var(--color-correct)]' : 'text-wrong'}`}>
                                {pct(n.beforeRate)} → {pct(n.afterRate)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
