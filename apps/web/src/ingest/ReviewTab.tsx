/**
 * P1b 抽检页：GET /api/v1/ingest/questions?status=extracted 列出待抽检题，
 * 每题可「核验通过」（支持先内联编辑 stem/answer/难度，带 patch）、「剔除」或「跳过」。
 */
import { useCallback, useEffect, useState } from 'react'
import { extractErrorMessage, inputCls, LEVEL_LABELS } from './shared'
import type { Level } from './shared'

interface ReviewQuestion {
    id: string
    stem: string
    answer: string
    difficulty: number
    level?: Level
    nodeIds: string[]
    options?: string[]
    analysis?: string
    sourceFile?: string
}

interface ReviewList {
    total: number
    extracted: number
    items: ReviewQuestion[]
}

function normalizeQuestion(raw: unknown): ReviewQuestion | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.stem !== 'string') return null
    const source = o.source && typeof o.source === 'object' ? (o.source as Record<string, unknown>) : {}
    return {
        id: o.id,
        stem: o.stem,
        answer: typeof o.answer === 'string' ? o.answer : '',
        difficulty:
            typeof o.difficulty === 'number' ? Math.min(5, Math.max(1, Math.round(o.difficulty))) : 3,
        level: typeof o.level === 'string' && o.level in LEVEL_LABELS ? (o.level as Level) : undefined,
        nodeIds: Array.isArray(o.nodeIds) ? o.nodeIds.filter((x): x is string => typeof x === 'string') : [],
        options: Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : undefined,
        analysis: typeof o.analysis === 'string' ? o.analysis : undefined,
        sourceFile: typeof source.file === 'string' ? source.file : undefined,
    }
}

function QuestionCard({
    q,
    busy,
    onVerify,
    onReject,
    onSkip,
}: {
    q: ReviewQuestion
    busy: boolean
    onVerify: (patch: { stem?: string; answer?: string; difficulty?: number } | undefined) => void
    onReject: () => void
    onSkip: () => void
}) {
    const [editing, setEditing] = useState(false)
    const [stem, setStem] = useState(q.stem)
    const [answer, setAnswer] = useState(q.answer)
    const [difficulty, setDifficulty] = useState(q.difficulty)

    const handleVerify = () => {
        const patch: { stem?: string; answer?: string; difficulty?: number } = {}
        if (stem !== q.stem) patch.stem = stem
        if (answer !== q.answer) patch.answer = answer
        if (difficulty !== q.difficulty) patch.difficulty = difficulty
        onVerify(Object.keys(patch).length > 0 ? patch : undefined)
    }

    return (
        <div className="rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm space-y-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                    {editing ? (
                        <textarea
                            value={stem}
                            onChange={(e) => setStem(e.target.value)}
                            rows={3}
                            className={`${inputCls} resize-y`}
                        />
                    ) : (
                        <p className="whitespace-pre-wrap text-sm text-slate-700">{stem}</p>
                    )}
                    {q.options && q.options.length > 0 && (
                        <p className="text-xs text-slate-500">选项：{q.options.join(' / ')}</p>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => setEditing((v) => !v)}
                    className="shrink-0 text-xs text-sky-500 hover:text-sky-700"
                >
                    {editing ? '收起编辑' : '编辑'}
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
                <span className="flex items-center gap-1.5">
                    答案：
                    {editing ? (
                        <input
                            type="text"
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-300"
                        />
                    ) : (
                        <span className="font-medium text-emerald-600">{answer || '（无）'}</span>
                    )}
                </span>
                <span className="flex items-center gap-1.5">
                    难度：
                    {editing ? (
                        <select
                            value={difficulty}
                            onChange={(e) => setDifficulty(Number(e.target.value))}
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-300"
                        >
                            {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                    {'★'.repeat(n)}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <span className="text-amber-500">{'★'.repeat(difficulty)}</span>
                    )}
                </span>
                {q.level && <span>学段：{LEVEL_LABELS[q.level]}</span>}
                {q.sourceFile && <span>来源：{q.sourceFile}</span>}
            </div>

            {q.nodeIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {q.nodeIds.map((n) => (
                        <span
                            key={n}
                            className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs text-sky-700"
                        >
                            {n}
                        </span>
                    ))}
                </div>
            )}

            {q.analysis && <p className="text-xs text-slate-400">解析：{q.analysis}</p>}

            <div className="flex justify-end gap-2 pt-1">
                <button
                    type="button"
                    disabled={busy}
                    onClick={onSkip}
                    className="rounded-full border border-slate-200 px-4 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    跳过
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={onReject}
                    className="rounded-full border border-red-200 px-4 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    剔除
                </button>
                <button
                    type="button"
                    disabled={busy}
                    onClick={handleVerify}
                    className="rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-white shadow hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                    核验通过
                </button>
            </div>
        </div>
    )
}

export function ReviewTab() {
    const [list, setList] = useState<ReviewList | null>(null)
    const [loading, setLoading] = useState(false)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [skipped, setSkipped] = useState<Set<string>>(new Set())

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const res = await fetch('/api/v1/ingest/questions?status=extracted&limit=100')
            if (!res.ok) {
                setError(await extractErrorMessage(res, '抽检接口尚未就绪。'))
                return
            }
            const body = (await res.json()) as { total?: unknown; extracted?: unknown; items?: unknown[] }
            setList({
                total: typeof body.total === 'number' ? body.total : 0,
                extracted: typeof body.extracted === 'number' ? body.extracted : 0,
                items: (body.items ?? [])
                    .map(normalizeQuestion)
                    .filter((q): q is ReviewQuestion => q !== null),
            })
            setSkipped(new Set())
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const review = async (
        questionId: string,
        verdict: 'verified' | 'rejected',
        patch?: { stem?: string; answer?: string; difficulty?: number }
    ) => {
        setBusyId(questionId)
        setError(null)
        try {
            const res = await fetch('/api/v1/ingest/review', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ questionId, verdict, ...(patch ? { patch } : {}) }),
            })
            if (!res.ok) {
                setError(await extractErrorMessage(res, '抽检接口尚未就绪。'))
                return
            }
            await load()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusyId(null)
        }
    }

    const visible = (list?.items ?? []).filter((q) => !skipped.has(q.id))

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
                <p className="text-sm text-slate-500">
                    {list ? (
                        <>
                            题库共 <span className="font-semibold text-slate-700">{list.total}</span> 题 · 待抽检{' '}
                            <span className="font-semibold text-amber-600">{list.extracted}</span> 题
                        </>
                    ) : (
                        '加载中…'
                    )}
                </p>
                <button
                    type="button"
                    disabled={loading}
                    onClick={() => void load()}
                    className="rounded-full border border-slate-200 px-4 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {loading ? '刷新中…' : '刷新'}
                </button>
            </div>

            {error && (
                <div className="rounded-xl border-l-4 border-red-400 bg-red-50/70 p-4">
                    <p className="text-sm text-red-600">{error}</p>
                </div>
            )}

            {!loading && list && visible.length === 0 && (
                <p className="rounded-2xl border border-slate-200 bg-white/60 py-10 text-center text-sm text-slate-400">
                    没有待抽检的题
                </p>
            )}

            {visible.map((q) => (
                <QuestionCard
                    key={q.id}
                    q={q}
                    busy={busyId === q.id}
                    onVerify={(patch) => void review(q.id, 'verified', patch)}
                    onReject={() => {
                        if (window.confirm('确认剔除这道题？剔除后不会进入题库。')) {
                            void review(q.id, 'rejected')
                        }
                    }}
                    onSkip={() => setSkipped((s) => new Set(s).add(q.id))}
                />
            ))}
        </div>
    )
}
