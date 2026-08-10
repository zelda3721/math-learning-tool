/**
 * 错题本页（P3）：按日期分组列出归因过的错题，每题两条出路——
 * 「再看讲解」复用 ExplanationView，「再练一道」复用 VariantGate。
 */
import { useEffect, useState } from 'react'
import { useLearner } from '../learner/LearnerContext'
import { fetchMistakes, type MistakeSummary } from '../practice/api'
import { ConfidenceBadge } from '../practice/DiagnosisCard'
import { ExplanationView } from '../practice/ExplanationView'
import { LearnerGate, LearnerSwitcher } from '../practice/LearnerGate'
import { VariantGate } from '../practice/VariantGate'
import { Badge, Button, EmptyState, LoadingState, PageHeader } from '../ui'

type ListState =
    | { kind: 'loading' }
    | { kind: 'ready'; mistakes: MistakeSummary[] }

/** 展开中的操作面板：某条错题的讲解或变式 */
type ActivePanel = { mistakeId: string; mode: 'explain' | 'variant' } | null

function dateKey(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '更早'
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

/** 保持列表原有顺序（server 按时间返回）分组到日期桶 */
function groupByDate(mistakes: MistakeSummary[]): [string, MistakeSummary[]][] {
    const groups = new Map<string, MistakeSummary[]>()
    for (const m of mistakes) {
        const key = dateKey(m.createdAt)
        const bucket = groups.get(key)
        if (bucket) bucket.push(m)
        else groups.set(key, [m])
    }
    return [...groups.entries()]
}

export function MistakeBook() {
    const { learner } = useLearner()
    const [state, setState] = useState<ListState>({ kind: 'loading' })
    const [active, setActive] = useState<ActivePanel>(null)

    const learnerId = learner?.id
    useEffect(() => {
        if (!learnerId) return
        let cancelled = false
        setState({ kind: 'loading' })
        setActive(null)
        void fetchMistakes(learnerId).then((mistakes) => {
            if (!cancelled) setState({ kind: 'ready', mistakes })
        })
        return () => {
            cancelled = true
        }
    }, [learnerId])

    if (!learner) return <LearnerGate />

    return (
        <div className="space-y-4">
            <PageHeader
                title="错题本"
                subtitle="每道错题都标好了根因，讲解和再练一道都在这"
                actions={
                    state.kind === 'ready' && state.mistakes.length > 0 ? (
                        <span className="text-sm text-ink-faint">
                            共 <span className="numeric">{state.mistakes.length}</span> 道
                        </span>
                    ) : undefined
                }
            />
            <LearnerSwitcher />

            {state.kind === 'loading' && <LoadingState text="正在翻错题本……" />}

            {state.kind === 'ready' && state.mistakes.length === 0 && (
                <EmptyState icon="🎉" title="还没有错题，太棒了" hint="继续保持，把更多星星点亮吧。" />
            )}

            {state.kind === 'ready' &&
                groupByDate(state.mistakes).map(([date, items]) => (
                    <section key={date} className="space-y-3">
                        <h3 className="eyebrow px-1 pt-3">{date}</h3>
                        {items.map((m) => (
                            <MistakeItem
                                key={m.id}
                                mistake={m}
                                learnerId={learner.id}
                                active={active?.mistakeId === m.id ? active.mode : null}
                                onOpen={(mode) => setActive({ mistakeId: m.id, mode })}
                                onClose={() => setActive(null)}
                            />
                        ))}
                    </section>
                ))}
        </div>
    )
}

interface ItemProps {
    mistake: MistakeSummary
    learnerId: string
    active: 'explain' | 'variant' | null
    onOpen: (mode: 'explain' | 'variant') => void
    onClose: () => void
}

function MistakeItem({ mistake: m, learnerId, active, onOpen, onClose }: ItemProps) {
    return (
        <div className="plate p-5 md:p-6 space-y-3">
            {m.questionStem && (
                <p className="text-lg font-medium text-ink leading-relaxed whitespace-pre-wrap">
                    {m.questionStem}
                </p>
            )}

            {/* 根因坐标 + 置信度文案（宪法第 4 条：归因必须带置信度） */}
            <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow">卡住的地方</span>
                <span className="font-bold text-ink">{m.rootNodeName}</span>
                <ConfidenceBadge confidence={m.confidence} />
                {!m.eligible && <Badge tone="beam">待探针确认</Badge>}
            </div>

            {m.chainNames.length > 0 && (
                <div className="rounded-[10px] bg-paper border border-rule px-4 py-2.5">
                    <span className="eyebrow mr-2">依据链</span>
                    <span className="text-sm text-ink-soft">{m.chainNames.join(' → ')}</span>
                </div>
            )}

            {active === null && (
                <div className="flex flex-wrap gap-3 pt-1">
                    <Button onClick={() => onOpen('explain')}>再看讲解</Button>
                    <Button variant="secondary" onClick={() => onOpen('variant')}>
                        再练一道
                    </Button>
                </div>
            )}

            {active === 'explain' && (
                <div className="border-t border-rule pt-4">
                    <ExplanationView
                        request={{
                            learnerId,
                            questionId: m.questionId,
                            mistakeId: m.id,
                            focusNodeId: m.rootNodeId,
                            misconceptionId: m.misconceptionId,
                        }}
                        primaryLabel="收起"
                        onPrimary={onClose}
                    />
                </div>
            )}

            {active === 'variant' && (
                <div className="border-t border-rule pt-4">
                    <VariantGate
                        learnerId={learnerId}
                        questionId={m.questionId}
                        onDone={onClose}
                    />
                </div>
            )}
        </div>
    )
}
