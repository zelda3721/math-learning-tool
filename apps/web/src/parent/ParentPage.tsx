import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLearner } from '../learner/LearnerContext'
import { LearnerGate, LearnerSwitcher } from '../practice/LearnerGate'
import { Button, ErrorState, LoadingState, PageHeader } from '../ui'
import { ChildrenPanel } from './ChildrenPanel'
import {
    ApiError,
    fetchParentSummary,
    postCorrectMistake,
    postVerdict,
    type ParentSummary,
    type PendingVerdict,
    type RecentMistake,
    type TrendDay,
} from './api'

/** 顶部统计行：点亮/微光/暗 + 到期复习 + 近14天练习天数 */
function StatsRow({ summary }: { summary: ParentSummary }) {
    const practicedDays = summary.trend.filter((d) => d.attempts > 0).length
    const stats: { label: string; value: number; cls: string }[] = [
        { label: '点亮', value: summary.mastery.lit, cls: 'text-sky-500' },
        { label: '微光', value: summary.mastery.glow, cls: 'text-amber-500' },
        { label: '暗', value: summary.mastery.dim, cls: 'text-slate-400' },
        { label: '到期复习', value: summary.dueReviews, cls: 'text-rose-500' },
        { label: '近14天练习天数', value: practicedDays, cls: 'text-emerald-500' },
    ]
    return (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {stats.map((s) => (
                <div key={s.label} className="soft-glass p-4 text-center">
                    <div className={`text-2xl font-bold ${s.cls}`}>{s.value}</div>
                    <div className="text-xs text-slate-500 mt-1">{s.label}</div>
                </div>
            ))}
        </div>
    )
}

/** 错因模式卡：nodeName + 条形（share% 宽度）+ 平均置信度 */
function MistakePatterns({ summary }: { summary: ParentSummary }) {
    return (
        <section className="soft-glass p-6 space-y-4">
            <h3 className="text-lg font-bold text-slate-700">错因模式</h3>
            {summary.mistakePatterns.length === 0 ? (
                <p className="text-sm text-slate-400">还没有足够数据</p>
            ) : (
                <ul className="space-y-3">
                    {summary.mistakePatterns.map((p) => (
                        <li key={p.nodeId} className="space-y-1">
                            <div className="flex items-baseline justify-between gap-3">
                                <span className="font-semibold text-slate-700 text-sm">{p.nodeName}</span>
                                <span className="text-xs text-slate-400 shrink-0">
                                    {p.count} 次 · 平均置信度 {Math.round(p.avgConfidence * 100)}%
                                </span>
                            </div>
                            <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-gradient-to-r from-rose-300 to-rose-400"
                                    style={{ width: `${Math.max(4, Math.round(p.share * 100))}%` }}
                                />
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

/** 判卷抽检：家长复核存疑判定，判定后推进掌握度 */
function VerdictQueue({
    items,
    onResolved,
}: {
    items: PendingVerdict[]
    onResolved: (attemptId: string, backfilled: number) => void
}) {
    const [notes, setNotes] = useState<Record<string, string>>({})
    const [busy, setBusy] = useState<string | null>(null)
    const [errors, setErrors] = useState<Record<string, string>>({})

    const judge = async (item: PendingVerdict, verdict: 'correct' | 'incorrect') => {
        if (busy) return
        setBusy(item.attemptId)
        setErrors((prev) => ({ ...prev, [item.attemptId]: '' }))
        try {
            const note = notes[item.attemptId]?.trim()
            const res = await postVerdict({
                attemptId: item.attemptId,
                verdict,
                ...(note ? { note } : {}),
            })
            onResolved(item.attemptId, res.mastery.length)
        } catch (err) {
            setErrors((prev) => ({
                ...prev,
                [item.attemptId]: err instanceof Error ? err.message : String(err),
            }))
        } finally {
            setBusy(null)
        }
    }

    return (
        <section className="soft-glass p-6 space-y-4">
            <h3 className="text-lg font-bold text-slate-700">
                判卷抽检
                {items.length > 0 && (
                    <span className="ml-2 text-xs font-semibold text-amber-600 bg-amber-100 border border-amber-200 rounded-full px-2.5 py-0.5">
                        {items.length} 条待复核
                    </span>
                )}
            </h3>
            {items.length === 0 ? (
                <p className="text-sm text-slate-400">没有待复核的判定</p>
            ) : (
                <ul className="space-y-4">
                    {items.map((item) => (
                        <li
                            key={item.attemptId}
                            className="rounded-2xl border border-slate-100 bg-white/60 p-4 space-y-3"
                        >
                            <p className="text-sm text-slate-700 font-medium">{item.questionStem}</p>
                            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                                <span className="text-slate-500">
                                    参考答案：<span className="font-semibold text-slate-700">{item.correctAnswer}</span>
                                </span>
                                <span className="text-slate-500">
                                    学生作答：<span className="font-semibold text-slate-700">{item.studentAnswer}</span>
                                </span>
                            </div>
                            <input
                                type="text"
                                value={notes[item.attemptId] ?? ''}
                                onChange={(e) =>
                                    setNotes((prev) => ({ ...prev, [item.attemptId]: e.target.value }))
                                }
                                placeholder="备注（可选）"
                                className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl placeholder:text-slate-300 text-slate-700 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition-all"
                            />
                            <div className="flex items-center gap-2">
                                <Button
                                    size="sm"
                                    disabled={busy !== null}
                                    onClick={() => void judge(item, 'correct')}
                                >
                                    判对
                                </Button>
                                <Button
                                    size="sm"
                                    variant="danger"
                                    disabled={busy !== null}
                                    onClick={() => void judge(item, 'incorrect')}
                                >
                                    判错
                                </Button>
                                {busy === item.attemptId && (
                                    <span className="text-xs text-slate-400">提交中……</span>
                                )}
                            </div>
                            {errors[item.attemptId] && (
                                <p className="text-xs text-red-500">{errors[item.attemptId]}</p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

/** 近期归因：题干 + 根因 + 置信度 + eligible 徽标 + 「归因不对？」纠正入口 */
function RecentMistakes({
    items,
    onCorrected,
}: {
    items: RecentMistake[]
    onCorrected: (mistakeId: string) => void
}) {
    const [expandedId, setExpandedId] = useState<string | null>(null)
    const [nodeIdInput, setNodeIdInput] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const toggle = (id: string) => {
        setExpandedId((prev) => (prev === id ? null : id))
        setNodeIdInput('')
        setError(null)
    }

    const confirm = async (mistake: RecentMistake) => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
            const rootNodeId = nodeIdInput.trim()
            await postCorrectMistake({
                mistakeId: mistake.id,
                ...(rootNodeId ? { rootNodeId } : {}),
            })
            onCorrected(mistake.id)
            setExpandedId(null)
            setNodeIdInput('')
        } catch (err) {
            if (err instanceof ApiError && err.status === 422) {
                setError('节点不存在，请检查节点 ID')
            } else {
                setError(err instanceof Error ? err.message : String(err))
            }
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className="soft-glass p-6 space-y-4">
            <h3 className="text-lg font-bold text-slate-700">近期归因</h3>
            {items.length === 0 ? (
                <p className="text-sm text-slate-400">还没有归因记录</p>
            ) : (
                <ul className="space-y-3">
                    {items.map((m) => (
                        <li
                            key={m.id}
                            className="rounded-2xl border border-slate-100 bg-white/60 p-4 space-y-2"
                        >
                            {m.questionStem && (
                                <p className="text-sm text-slate-700 font-medium">{m.questionStem}</p>
                            )}
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="text-slate-500">
                                    根因：<span className="font-semibold text-slate-700">{m.rootNodeName}</span>
                                </span>
                                <span className="text-xs text-slate-400">
                                    置信度 {Math.round(m.confidence * 100)}%
                                </span>
                                <span
                                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                                        m.eligible
                                            ? 'bg-sky-100 text-sky-600 border-sky-200'
                                            : 'bg-slate-100 text-slate-500 border-slate-200'
                                    }`}
                                >
                                    {m.eligible ? '已核验' : '待核验'}
                                </span>
                                {m.correctedByParent && (
                                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-emerald-100 text-emerald-600 border-emerald-200">
                                        家长已纠正
                                    </span>
                                )}
                            </div>
                            {!m.correctedByParent && (
                                <div className="pt-1">
                                    <button
                                        type="button"
                                        onClick={() => toggle(m.id)}
                                        className="text-xs font-semibold text-sky-500 hover:text-sky-700 transition-colors"
                                    >
                                        {expandedId === m.id ? '收起' : '归因不对？'}
                                    </button>
                                    {expandedId === m.id && (
                                        <div className="mt-2 space-y-2">
                                            <input
                                                type="text"
                                                value={nodeIdInput}
                                                onChange={(e) => setNodeIdInput(e.target.value)}
                                                placeholder="正确的节点 ID（留空=仅标记归因有误）"
                                                className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-xl placeholder:text-slate-300 text-slate-700 focus:outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100 transition-all"
                                            />
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    size="sm"
                                                    disabled={busy}
                                                    onClick={() => void confirm(m)}
                                                >
                                                    {busy ? '提交中……' : '确认'}
                                                </Button>
                                                {error && <p className="text-xs text-red-500">{error}</p>}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

/** 14 天趋势：纯 div 条形，高度=attempts，正确比例着色，不引图表库 */
function TrendChart({ trend }: { trend: TrendDay[] }) {
    const maxAttempts = Math.max(1, ...trend.map((d) => d.attempts))
    return (
        <section className="soft-glass p-6 space-y-4">
            <h3 className="text-lg font-bold text-slate-700">14 天趋势</h3>
            {trend.length === 0 ? (
                <p className="text-sm text-slate-400">还没有练习记录</p>
            ) : (
                <>
                    <div className="flex items-end gap-1.5 h-28">
                        {trend.map((d) => {
                            const barPct = (d.attempts / maxAttempts) * 100
                            const correctPct = d.attempts > 0 ? (d.correct / d.attempts) * 100 : 0
                            return (
                                <div
                                    key={d.date}
                                    className="flex-1 h-full flex flex-col justify-end"
                                    title={`${d.date}：练 ${d.attempts} 题，对 ${d.correct} 题，提示 ${d.hints} 次`}
                                >
                                    {d.attempts === 0 ? (
                                        <div className="h-1 rounded-full bg-slate-100" />
                                    ) : (
                                        <div
                                            className="rounded-t-md bg-slate-200 overflow-hidden flex flex-col justify-end"
                                            style={{ height: `${Math.max(barPct, 8)}%` }}
                                        >
                                            <div
                                                className="bg-sky-400"
                                                style={{ height: `${correctPct}%` }}
                                            />
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                    <div className="flex justify-between text-xs text-slate-400">
                        <span>{trend[0].date.slice(5)}</span>
                        <span className="flex items-center gap-3">
                            <span className="flex items-center gap-1">
                                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-sky-400" />
                                答对
                            </span>
                            <span className="flex items-center gap-1">
                                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-200" />
                                答错
                            </span>
                        </span>
                        <span>{trend[trend.length - 1].date.slice(5)}</span>
                    </div>
                </>
            )}
        </section>
    )
}

/** 家长聚合页：一屏看清孩子的掌握度、错因模式与待办复核。 */
export function ParentPage() {
    const { learner } = useLearner()
    const [summary, setSummary] = useState<ParentSummary | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [verdictMsg, setVerdictMsg] = useState<string | null>(null)

    const learnerId = learner?.id

    const load = useCallback(async (id: string) => {
        setLoading(true)
        setError(null)
        try {
            setSummary(await fetchParentSummary(id))
        } catch (err) {
            setSummary(null)
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        setSummary(null)
        setVerdictMsg(null)
        if (learnerId) void load(learnerId)
    }, [learnerId, load])

    const handleVerdictResolved = useCallback((attemptId: string, backfilled: number) => {
        setSummary((prev) =>
            prev
                ? {
                      ...prev,
                      pendingVerdicts: prev.pendingVerdicts.filter((v) => v.attemptId !== attemptId),
                  }
                : prev
        )
        setVerdictMsg(
            backfilled > 0 ? `已判定，掌握度已回填 ${backfilled} 个节点` : '已判定，掌握度已同步'
        )
    }, [])

    const handleMistakeCorrected = useCallback((mistakeId: string) => {
        setSummary((prev) =>
            prev
                ? {
                      ...prev,
                      recentMistakes: prev.recentMistakes.map((m) =>
                          m.id === mistakeId ? { ...m, correctedByParent: true } : m
                      ),
                  }
                : prev
        )
    }, [])

    const content = useMemo(() => {
        if (!learner) return <LearnerGate />
        if (loading && !summary) {
            return <LoadingState text="正在加载家长视图……" />
        }
        if (error) {
            return (
                <ErrorState
                    message={`加载失败：${error}`}
                    onRetry={() => {
                        if (learnerId) void load(learnerId)
                    }}
                />
            )
        }
        if (!summary) return null
        return (
            <div className="space-y-6">
                <StatsRow summary={summary} />
                {verdictMsg && (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-700">
                        {verdictMsg}
                    </div>
                )}
                <VerdictQueue items={summary.pendingVerdicts} onResolved={handleVerdictResolved} />
                <MistakePatterns summary={summary} />
                <RecentMistakes items={summary.recentMistakes} onCorrected={handleMistakeCorrected} />
                <TrendChart trend={summary.trend} />
            </div>
        )
    }, [
        learner,
        learnerId,
        loading,
        error,
        summary,
        verdictMsg,
        load,
        handleVerdictResolved,
        handleMistakeCorrected,
    ])

    return (
        <div className="space-y-6">
            <PageHeader title="家长中心" subtitle="错因模式 · 进步趋势 · 判卷抽检 · 账号管理" />
            <LearnerSwitcher disabled={loading} />
            {content}
            <ChildrenPanel />
        </div>
    )
}
