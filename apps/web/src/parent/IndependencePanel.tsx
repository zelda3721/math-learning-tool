import { useCallback, useEffect, useState } from 'react'

import { ErrorState, LoadingState } from '../ui'
import { fetchIndependence, fetchReflections, type IndependenceReport, type ReflectionItem } from './api'

/**
 * 「孩子是在自己学，还是在依赖 AI」面板。
 *
 * 报告里两条偏差互相咬着：系统不度量依赖、家长看不出学习是否真的发生。
 * 这块面板只放**数字和原话**，不放评价：
 * - 新题首答靠自己一次做对的比例（最硬的一条）
 * - 提示深度分布（0/1/2/3 级各多少次）
 * - 看了几次解析、问过几次题库外的题、重复交了几次
 * - 孩子自己讲过的思路（原话，不是模型转述）
 *
 * 口径全部来自服务端统计，不在前端算、也不让模型判。
 */

const GUESS_LABEL: Record<string, string> = {
    reading: '没读懂题',
    calculation: '算错了',
    procedure: '方法记混了',
    concept: '规则还没想明白',
    unknown: '说不上来',
}

export function IndependencePanel({ learnerId }: { learnerId: string }) {
    const [report, setReport] = useState<IndependenceReport | null>(null)
    const [reflections, setReflections] = useState<ReflectionItem[]>([])
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            const [r, refl] = await Promise.all([fetchIndependence(learnerId), fetchReflections(learnerId)])
            setReport(r)
            setReflections(refl.items)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        setReport(null)
        void load()
    }, [load])

    if (error) return <ErrorState message={`独立性数据加载失败：${error}`} onRetry={() => void load()} />
    if (!report) return <LoadingState text="正在算独立性指标……" />

    const rate = report.independentRate
    const hints = report.hintDistribution
    const hintTotal = hints.reduce((a, b) => a + b, 0)

    return (
        <section className="plate p-6 space-y-4">
            <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-ink">他是在自己学吗</h2>
                <span className="text-xs text-ink-faint numeric">{report.attempts} 次作答</span>
            </div>
            <p className="text-sm text-ink-soft leading-relaxed">{report.verdict}</p>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Stat
                    label="新题首答靠自己"
                    value={rate === null ? '—' : `${Math.round(rate * 100)}%`}
                    hint={`${report.independentFirstCorrect} / ${report.firstSeenQuestions} 道新题`}
                />
                <Stat label="看过解析" value={String(report.analysisViews)} hint="次" />
                <Stat label="问一道题" value={String(report.askCount)} hint="次" />
                <Stat label="重复交" value={String(report.repeats)} hint="次（不算证据）" />
            </div>

            {hintTotal > 0 && (
                <div className="space-y-1.5">
                    <div className="text-xs text-ink-faint">用到第几级提示</div>
                    <div className="flex h-3 rounded-full overflow-hidden bg-rule">
                        {hints.map((n, i) => (
                            <div
                                key={i}
                                className={
                                    i === 0
                                        ? 'bg-correct h-full'
                                        : i === 1
                                          ? 'bg-beam h-full'
                                          : i === 2
                                            ? 'bg-[color:var(--color-glow,#c8a24a)] h-full'
                                            : 'bg-wrong h-full'
                                }
                                style={{ width: `${(n / hintTotal) * 100}%` }}
                                title={`${i} 级提示：${n} 次`}
                            />
                        ))}
                    </div>
                    <div className="flex justify-between text-[11px] text-ink-faint numeric">
                        <span>自己做对 {hints[0]}</span>
                        <span>1 级 {hints[1]}</span>
                        <span>2 级 {hints[2]}</span>
                        <span>3 级 {hints[3]}</span>
                    </div>
                </div>
            )}

            <div className="space-y-2">
                <div className="text-xs text-ink-faint">
                    他自己说的（{report.selfExplain} 次讲思路 · {report.errorGuess} 次说错因；都不是评分，判不了对错）
                </div>
                {reflections.length === 0 ? (
                    <p className="text-sm text-ink-faint">还没有。答错时问一句「你觉得错在哪」、第一次做对时请他讲讲思路，这里就会有。</p>
                ) : (
                    <ul className="space-y-2">
                        {reflections.slice(0, 8).map((r, i) => (
                            <li key={`${r.at}-${i}`} className="rounded-[10px] border border-rule bg-plate px-3 py-2 space-y-1">
                                <div className="flex items-center justify-between gap-3 text-xs text-ink-faint">
                                    <span className="truncate">{r.questionStem ?? r.questionId ?? '题目'}</span>
                                    <span className="numeric shrink-0">{r.at.slice(5, 16).replace('T', ' ')}</span>
                                </div>
                                <p className="text-sm text-ink-soft">
                                    {r.kind === 'error-guess'
                                        ? `他说自己：${r.guess ? (GUESS_LABEL[r.guess] ?? r.guess) : '（没说）'}`
                                        : r.text || '（没写）'}
                                </p>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="rounded-[10px] border border-rule bg-plate px-3 py-3">
            <div className="text-xs text-ink-faint">{label}</div>
            <div className="text-2xl font-semibold text-ink numeric leading-tight">{value}</div>
            {hint && <div className="text-[11px] text-ink-faint">{hint}</div>}
        </div>
    )
}
