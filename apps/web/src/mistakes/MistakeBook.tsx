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
            <LearnerSwitcher />

            <div className="flex items-baseline justify-between px-1">
                <h2 className="text-2xl font-bold text-slate-700">错题本</h2>
                {state.kind === 'ready' && state.mistakes.length > 0 && (
                    <span className="text-sm text-slate-400">共 {state.mistakes.length} 道</span>
                )}
            </div>

            {state.kind === 'loading' && (
                <div className="text-center text-slate-400 py-16">正在翻错题本……</div>
            )}

            {state.kind === 'ready' && state.mistakes.length === 0 && (
                <div className="soft-glass p-12 text-center space-y-3">
                    <p className="text-4xl">🎉</p>
                    <h3 className="text-xl font-bold text-slate-700">还没有错题，太棒了</h3>
                    <p className="text-slate-500">继续保持，把更多星星点亮吧。</p>
                </div>
            )}

            {state.kind === 'ready' &&
                groupByDate(state.mistakes).map(([date, items]) => (
                    <section key={date} className="space-y-3">
                        <h3 className="text-sm font-bold text-slate-400 px-1 pt-2">{date}</h3>
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
        <div className="soft-glass p-5 md:p-6 space-y-3">
            {m.questionStem && (
                <p className="text-lg font-semibold text-slate-700 leading-relaxed whitespace-pre-wrap">
                    {m.questionStem}
                </p>
            )}

            {/* 根因坐标 + 置信度文案（宪法第 4 条：归因必须带置信度） */}
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-slate-400">卡住的地方</span>
                <span className="font-bold text-indigo-600">{m.rootNodeName}</span>
                <ConfidenceBadge confidence={m.confidence} />
                {!m.eligible && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-sky-100 text-sky-600 border-sky-200">
                        待探针确认
                    </span>
                )}
            </div>

            {m.chainNames.length > 0 && (
                <div className="rounded-2xl bg-indigo-50/60 border border-indigo-100 px-4 py-2.5">
                    <span className="text-xs font-bold text-indigo-400 mr-2">依据链</span>
                    <span className="text-sm text-indigo-700">{m.chainNames.join(' → ')}</span>
                </div>
            )}

            {active === null && (
                <div className="flex flex-wrap gap-3 pt-1">
                    <button
                        type="button"
                        onClick={() => onOpen('explain')}
                        className="px-6 py-2.5 rounded-2xl bg-sky-500 text-white font-bold shadow-lg shadow-sky-200 hover:bg-sky-600 transition-colors"
                    >
                        再看讲解
                    </button>
                    <button
                        type="button"
                        onClick={() => onOpen('variant')}
                        className="px-6 py-2.5 rounded-2xl bg-violet-500 text-white font-bold shadow-lg shadow-violet-200 hover:bg-violet-600 transition-colors"
                    >
                        再练一道
                    </button>
                </div>
            )}

            {active === 'explain' && (
                <div className="border-t border-slate-100 pt-4">
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
                <div className="border-t border-slate-100 pt-4">
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
