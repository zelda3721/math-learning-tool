import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLearner } from '../learner/LearnerContext'
import { LearnerGate, LearnerSwitcher } from '../practice/LearnerGate'
import { Badge, Button, ErrorState, LoadingState, PageHeader } from '../ui'
import { ChildrenPanel } from './ChildrenPanel'
import {
    ApiError,
    fetchParentSummary,
    postCorrectMistake,
    postVerdict,
    type ExplanationSource,
    type ParentSummary,
    type PendingVerdict,
    type RecentMistake,
    type TrendDay,
} from './api'

/** 卡片内输入框：与 .input-hero 同源，尺寸收紧一档 */
const fieldCls =
    'w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px] placeholder:text-ink-faint focus:outline-none focus:border-beam focus:ring-2 focus:ring-beam-wash transition-colors'

/** 顶部统计行：点亮/微光/暗 + 到期复习 + 近14天练习天数 */
function StatsRow({ summary }: { summary: ParentSummary }) {
    const practicedDays = summary.trend.filter((d) => d.attempts > 0).length
    const stats: { label: string; value: number; cls: string }[] = [
        // 金色只在"点亮/微光"这两个掌握度状态上出现——它们本来就是这个意思
        { label: '点亮', value: summary.mastery.lit, cls: 'text-lit' },
        { label: '微光', value: summary.mastery.glow, cls: 'text-glow' },
        { label: '暗', value: summary.mastery.dim, cls: 'text-ink-faint' },
        { label: '到期复习', value: summary.dueReviews, cls: 'text-ink' },
        { label: '近 14 天练习', value: practicedDays, cls: 'text-beam' },
    ]
    return (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {stats.map((s) => (
                <div key={s.label} className="plate p-4 text-center">
                    <div className={`numeric text-[26px] leading-none font-bold ${s.cls}`}>{s.value}</div>
                    <div className="eyebrow mt-2">{s.label}</div>
                </div>
            ))}
        </div>
    )
}


/** 引擎里确定性构造器盖的章 → 人话；没盖章的一律是模型写的计划 */
const SOURCE_LABEL: Record<string, string> = {
    llm_director: '模型导演',
    llm_html: '模型直写页面',
    linear_mix_swap: '假设法（确定性）',
    quantity_story: '数量叙事（确定性）',
    linear_balance: '天平（确定性）',
    verified_solution_arithmetic: '验算算式（确定性）',
    minimal_narrative: '最小叙事（降级）',
    graph_transform: '图像变换（确定性）',
}

/**
 * 讲解画面来源：同一道题，走确定性构造器和掉到模型导演，画出来的东西不是一回事。
 * 不记这一笔就只能凭感觉判断画质波动；这里把比例摊开，调哪一端有据可依。
 */
function ExplanationSources({ rows }: { rows: ExplanationSource[] }) {
    const total = rows.reduce((s, r) => s + r.count, 0)
    if (total === 0) return null
    const bySource = new Map<string, { count: number; clear: number; confusing: number }>()
    for (const r of rows) {
        const acc = bySource.get(r.source) ?? { count: 0, clear: 0, confusing: 0 }
        acc.count += r.count
        acc.clear += r.clear_votes ?? 0
        acc.confusing += r.confusing_votes ?? 0
        bySource.set(r.source, acc)
    }
    const sorted = [...bySource.entries()].sort((a, b) => b[1].count - a[1].count)
    const modelShare = Math.round((((bySource.get('llm_director')?.count ?? 0) / total) * 100))
    const degraded = bySource.get('minimal_narrative')?.count ?? 0
    const votes = sorted.reduce((s, [, v]) => s + v.clear + v.confusing, 0)

    return (
        <section className="plate p-6 space-y-4">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h3 className="text-section">讲解画面来源</h3>
                <span className="numeric text-xs text-ink-faint">共 {total} 份</span>
            </div>
            <p className="text-sm text-ink-soft leading-relaxed">
                画面由确定性构造器从已验证的算式直接算出，还是由模型自己设计——
                后者占比越高，画质越不稳定。
            </p>
            <ul className="space-y-3">
                {sorted.map(([source, v]) => {
                    const pct = Math.round((v.count / total) * 100)
                    const isModel = source === 'llm_director' || source === 'llm_html'
                    const voted = v.clear + v.confusing
                    return (
                        <li key={source} className="space-y-1.5">
                            <div className="flex items-baseline justify-between gap-3">
                                <span className="font-semibold text-ink text-sm">
                                    {SOURCE_LABEL[source] ?? source}
                                </span>
                                <span className="numeric text-xs text-ink-faint shrink-0">
                                    {v.count} 份 · {pct}%
                                    {voted > 0 && (
                                        <>
                                            {' · '}
                                            <span className="text-[color:var(--color-correct)]">
                                                清楚 {v.clear}
                                            </span>
                                            {' / '}
                                            <span className="text-[color:var(--color-wrong)]">
                                                没懂 {v.confusing}
                                            </span>
                                        </>
                                    )}
                                </span>
                            </div>
                            <div className="h-1.5 rounded-full bg-rule overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${isModel ? 'bg-ink-faint' : 'bg-beam'}`}
                                    style={{ width: `${Math.max(2, pct)}%` }}
                                />
                            </div>
                        </li>
                    )
                })}
            </ul>
            <p className="text-xs text-ink-faint leading-relaxed">
                {modelShare}% 的讲解由模型设计画面
                {degraded > 0 ? ` · ${degraded} 份走了降级叙事` : ''}
                {votes > 0 ? ` · 已收到 ${votes} 条「讲得清楚吗」的反馈` : ''}
            </p>
        </section>
    )
}

/** 错因模式卡：nodeName + 条形（share% 宽度）+ 平均置信度 */
function MistakePatterns({ summary }: { summary: ParentSummary }) {
    return (
        <section className="plate p-6 space-y-4">
            <h3 className="text-section">错因模式</h3>
            {summary.mistakePatterns.length === 0 ? (
                <p className="text-sm text-ink-faint">还没有足够数据</p>
            ) : (
                <ul className="space-y-3">
                    {summary.mistakePatterns.map((p) => (
                        <li key={p.nodeId} className="space-y-1.5">
                            <div className="flex items-baseline justify-between gap-3">
                                <span className="font-semibold text-ink text-sm">{p.nodeName}</span>
                                <span className="numeric text-xs text-ink-faint shrink-0">
                                    {p.count} 次 · 平均置信度 {Math.round(p.avgConfidence * 100)}%
                                </span>
                            </div>
                            <div className="h-2 rounded-full bg-rule overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-beam"
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
        <section className="plate p-6 space-y-4">
            <div className="flex items-center gap-2.5">
                <h3 className="text-section">判卷抽检</h3>
                {items.length > 0 && (
                    <Badge tone="beam">
                        <span className="numeric">{items.length}</span>
                        <span className="ml-1">条待复核</span>
                    </Badge>
                )}
            </div>
            {items.length === 0 ? (
                <p className="text-sm text-ink-faint">没有待复核的判定</p>
            ) : (
                <ul className="space-y-4">
                    {items.map((item) => (
                        <li
                            key={item.attemptId}
                            className="rounded-[10px] border border-rule bg-paper p-4 space-y-3"
                        >
                            <p className="text-sm text-ink font-medium">{item.questionStem}</p>
                            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                                <span className="text-ink-soft">
                                    参考答案：<span className="numeric font-semibold text-ink">{item.correctAnswer}</span>
                                </span>
                                <span className="text-ink-soft">
                                    学生作答：<span className="numeric font-semibold text-ink">{item.studentAnswer}</span>
                                </span>
                            </div>
                            <input
                                type="text"
                                value={notes[item.attemptId] ?? ''}
                                onChange={(e) =>
                                    setNotes((prev) => ({ ...prev, [item.attemptId]: e.target.value }))
                                }
                                placeholder="备注（可选）"
                                className={fieldCls}
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
                                    <span className="text-xs text-ink-faint">提交中……</span>
                                )}
                            </div>
                            {errors[item.attemptId] && (
                                <p className="text-xs text-wrong">{errors[item.attemptId]}</p>
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
        <section className="plate p-6 space-y-4">
            <h3 className="text-section">近期归因</h3>
            {items.length === 0 ? (
                <p className="text-sm text-ink-faint">还没有归因记录</p>
            ) : (
                <ul className="space-y-3">
                    {items.map((m) => (
                        <li
                            key={m.id}
                            className="rounded-[10px] border border-rule bg-paper p-4 space-y-2"
                        >
                            {m.questionStem && (
                                <p className="text-sm text-ink font-medium">{m.questionStem}</p>
                            )}
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="text-ink-soft">
                                    根因：<span className="font-semibold text-ink">{m.rootNodeName}</span>
                                </span>
                                <span className="numeric text-xs text-ink-faint">
                                    置信度 {Math.round(m.confidence * 100)}%
                                </span>
                                <Badge tone={m.eligible ? 'correct' : 'slate'}>
                                    {m.eligible ? '已核验' : '待核验'}
                                </Badge>
                                {m.correctedByParent && <Badge tone="beam">家长已纠正</Badge>}
                            </div>
                            {!m.correctedByParent && (
                                <div className="pt-1">
                                    <button
                                        type="button"
                                        onClick={() => toggle(m.id)}
                                        className="text-xs font-semibold text-beam hover:text-beam-deep transition-colors"
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
                                                className={fieldCls}
                                            />
                                            <div className="flex items-center gap-2">
                                                <Button
                                                    size="sm"
                                                    disabled={busy}
                                                    onClick={() => void confirm(m)}
                                                >
                                                    {busy ? '提交中……' : '确认'}
                                                </Button>
                                                {error && <p className="text-xs text-wrong">{error}</p>}
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
        <section className="plate p-6 space-y-4">
            <h3 className="text-section">14 天趋势</h3>
            {trend.length === 0 ? (
                <p className="text-sm text-ink-faint">还没有练习记录</p>
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
                                        <div className="h-1 rounded-full bg-rule" />
                                    ) : (
                                        <div
                                            className="rounded-t-[4px] bg-rule overflow-hidden flex flex-col justify-end"
                                            style={{ height: `${Math.max(barPct, 8)}%` }}
                                        >
                                            <div
                                                className="bg-beam"
                                                style={{ height: `${correctPct}%` }}
                                            />
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                    <div className="flex justify-between text-xs text-ink-faint">
                        <span className="numeric">{trend[0].date.slice(5)}</span>
                        <span className="flex items-center gap-3">
                            <span className="flex items-center gap-1.5">
                                <span className="inline-block w-2.5 h-2.5 rounded-[3px] bg-beam" />
                                答对
                            </span>
                            <span className="flex items-center gap-1.5">
                                <span className="inline-block w-2.5 h-2.5 rounded-[3px] bg-rule" />
                                答错
                            </span>
                        </span>
                        <span className="numeric">{trend[trend.length - 1].date.slice(5)}</span>
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
                    <div className="rounded-[10px] border border-correct/25 bg-correct-wash px-4 py-3 text-sm text-[color:var(--color-correct)]">
                        {verdictMsg}
                    </div>
                )}
                <VerdictQueue items={summary.pendingVerdicts} onResolved={handleVerdictResolved} />
                <MistakePatterns summary={summary} />
                <RecentMistakes items={summary.recentMistakes} onCorrected={handleMistakeCorrected} />
                <TrendChart trend={summary.trend} />
                <ExplanationSources rows={summary.explanationSources ?? []} />
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
