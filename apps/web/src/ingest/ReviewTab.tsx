/**
 * P1b 抽检页：GET /api/v1/ingest/questions?status=extracted 列出待抽检题，
 * 每题可「核验通过」（支持先内联编辑 stem/answer/难度，带 patch）、「剔除」或「跳过」。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, MathText } from '../ui'
import { QuestionImage } from '../practice/QuestionImage'
import { extractErrorMessage, inputCls, LEVEL_LABELS } from './shared'
import type { Level } from './shared'

interface ReviewQuestion {
    id: string
    stem: string
    answer: string
    difficulty: number
    level?: Level
    nodeIds: string[]
    nodeNames?: string[]
    options?: string[]
    analysis?: string
    sourceFile?: string
    /** 答案是模型自己算的（材料没印）；这类题核对前不发给孩子 */
    answerUnverified?: boolean
    /** 原题原图的文件名 */
    figureImage?: string
    /** 【解析】里老师画的解法图；做题时不给孩子看 */
    analysisImage?: string
}

interface ReviewList {
    total: number
    extracted: number
    /** 其中「答案是模型自己算的」有几道——这些题现在拿不到孩子手上 */
    blocked: number
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
        nodeNames: Array.isArray(o.nodeNames)
            ? o.nodeNames.filter((x): x is string => typeof x === 'string')
            : undefined,
        options: Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : undefined,
        analysis: typeof o.analysis === 'string' ? o.analysis : undefined,
        sourceFile: typeof source.file === 'string' ? source.file : undefined,
        answerUnverified: o.answerUnverified === true,
        figureImage: typeof o.figureImage === 'string' ? o.figureImage : undefined,
        analysisImage: typeof o.analysisImage === 'string' ? o.analysisImage : undefined,
    }
}

function QuestionCard({
    q,
    busy,
    onVerify,
    onReject,
    onSkip,
    onMoveFigure,
}: {
    q: ReviewQuestion
    busy: boolean
    onVerify: (patch: { stem?: string; answer?: string; difficulty?: number; nodeIds?: string[] } | undefined) => void
    onReject: () => void
    onSkip: () => void
    /** 分类器把图判错了：一键改判，不必为一张图重跑整份材料 */
    onMoveFigure: (to: 'analysis' | 'stem') => void
}) {
    const [editing, setEditing] = useState(false)
    const [stem, setStem] = useState(q.stem)
    const [answer, setAnswer] = useState(q.answer)
    const [difficulty, setDifficulty] = useState(q.difficulty)
    const [nodeIds, setNodeIds] = useState(q.nodeIds.join(', '))

    const handleVerify = () => {
        const patch: { stem?: string; answer?: string; difficulty?: number; nodeIds?: string[] } = {}
        if (stem !== q.stem) patch.stem = stem
        if (answer !== q.answer) patch.answer = answer
        if (difficulty !== q.difficulty) patch.difficulty = difficulty
        const ids = nodeIds.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
        if (ids.join(',') !== q.nodeIds.join(',') && ids.length > 0) patch.nodeIds = ids
        onVerify(Object.keys(patch).length > 0 ? patch : undefined)
    }

    return (
        <div
            className={`plate p-5 space-y-3 ${
                q.answerUnverified ? 'border-l-[3px] border-l-[color:var(--color-wrong)]' : ''
            }`}
        >
            {/* 这类题在核对之前根本不会发给孩子，所以说清楚"核对它才有用" */}
            {q.answerUnverified && (
                <p className="text-xs text-[color:var(--color-wrong)] leading-relaxed">
                    这道题的答案是模型自己算出来的，材料里没有印。
                    <b>核对之前它不会进孩子的练习</b>——请对着题目算一遍再通过。
                </p>
            )}
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
                        <p className="text-sm text-ink">
                            <MathText>{stem}</MathText>
                        </p>
                    )}
                    {q.options && q.options.length > 0 && (
                        <p className="text-xs text-ink-soft">选项：{q.options.join(' / ')}</p>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => setEditing((v) => !v)}
                    className="shrink-0 text-xs font-semibold text-beam hover:text-beam-deep transition-colors"
                >
                    {editing ? '收起编辑' : '编辑'}
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-soft">
                <span className="flex items-center gap-1.5">
                    <span className="eyebrow">答案</span>
                    {editing ? (
                        <input
                            type="text"
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            className={`${inputCls} numeric w-40`}
                        />
                    ) : (
                        <span className="numeric font-semibold text-ink">
                            {answer ? <MathText>{answer}</MathText> : '（无）'}
                        </span>
                    )}
                </span>
                <span className="flex items-center gap-1.5">
                    <span className="eyebrow">难度</span>
                    {editing ? (
                        <select
                            value={difficulty}
                            onChange={(e) => setDifficulty(Number(e.target.value))}
                            className={`${inputCls} numeric w-28`}
                        >
                            {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                    {n} · {'★'.repeat(n)}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <span className="numeric text-ink">
                            {difficulty} <span className="text-ink-faint">{'★'.repeat(difficulty)}</span>
                        </span>
                    )}
                </span>
                {q.level && (
                    <span className="flex items-center gap-1.5">
                        <span className="eyebrow">学段</span>
                        {LEVEL_LABELS[q.level]}
                    </span>
                )}
                {q.sourceFile && (
                    <span className="flex items-center gap-1.5">
                        <span className="eyebrow">来源</span>
                        {q.sourceFile}
                    </span>
                )}
            </div>

            {q.nodeIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {q.nodeIds.map((n, i) => (
                        <span
                            key={n}
                            title={n}
                            className="inline-flex items-center rounded-md border border-beam/20 bg-beam-wash px-2.5 py-1 text-xs text-beam"
                        >
                            {q.nodeNames?.[i] ?? n}
                        </span>
                    ))}
                </div>
            )}

            {/* 几何题不看图没法核对答案。两张图必须分得清楚：
                题干图孩子做题时看得见，解析图只在讲解时出现 */}
            {q.figureImage && (
                <div>
                    <div className="flex items-baseline justify-between gap-3 mb-1">
                        <span className="eyebrow">题干配图 · 孩子做题时看这张</span>
                        {/* 判错的方向恰恰危险：答案表挂成题干图，孩子一打开就看见答案 */}
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => onMoveFigure('analysis')}
                            className="text-xs text-ink-faint hover:text-wrong transition-colors"
                        >
                            这其实是解析里的图 →
                        </button>
                    </div>
                    <QuestionImage name={q.figureImage} />
                </div>
            )}
            {q.analysisImage && (
                <div>
                    <div className="flex items-baseline justify-between gap-3 mb-1">
                        <span className="eyebrow text-[color:var(--color-correct)]">
                            讲义解析里的解法图 · 只在讲解时出现，做题时不给孩子看
                        </span>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => onMoveFigure('stem')}
                            className="text-xs text-ink-faint hover:text-beam transition-colors"
                        >
                            ← 这其实是题干的图
                        </button>
                    </div>
                    <QuestionImage name={q.analysisImage} alt="讲义解析里的解法图" />
                </div>
            )}

            {editing && (
                <label className="block">
                    <span className="eyebrow block mb-1">知识点 id（逗号分隔；图谱里没有的会被拒绝）</span>
                    <input
                        type="text"
                        value={nodeIds}
                        onChange={(e) => setNodeIds(e.target.value)}
                        className={`${inputCls} mt-1`}
                    />
                </label>
            )}

            {q.analysis && <p className="text-xs text-ink-faint">解析：{q.analysis}</p>}

            <div className="flex justify-end gap-2 pt-1">
                <Button size="sm" variant="ghost" disabled={busy} onClick={onSkip}>
                    跳过
                </Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={onReject}>
                    剔除
                </Button>
                <Button size="sm" disabled={busy} onClick={handleVerify}>
                    核验通过
                </Button>
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
            const body = (await res.json()) as {
                total?: unknown
                extracted?: unknown
                blocked?: unknown
                items?: unknown[]
            }
            setList({
                total: typeof body.total === 'number' ? body.total : 0,
                extracted: typeof body.extracted === 'number' ? body.extracted : 0,
                blocked: typeof body.blocked === 'number' ? body.blocked : 0,
                // 答案是模型自己算的那些排最前：它们在核对之前根本不会发给孩子，
                // 也就是说抽检它们才有直接收益，抽检别的只是打个标记
                items: (body.items ?? [])
                    .map(normalizeQuestion)
                    .filter((q): q is ReviewQuestion => q !== null)
                    .sort((a, b) => Number(b.answerUnverified) - Number(a.answerUnverified)),
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
        patch?: { stem?: string; answer?: string; difficulty?: number; nodeIds?: string[] }
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

    /** 改判图的归属：分类判据是版面结构，讲义排版千奇百怪，总会有判错的时候 */
    const moveFigure = async (questionId: string, to: 'analysis' | 'stem') => {
        setBusyId(questionId)
        setError(null)
        try {
            const res = await fetch(`/api/v1/bank/questions/${encodeURIComponent(questionId)}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(
                    to === 'analysis' ? { moveFigureToAnalysis: true } : { moveAnalysisToFigure: true },
                ),
            })
            if (!res.ok) {
                setError(await extractErrorMessage(res, '题库接口尚未就绪。'))
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
                <p className="text-sm text-ink-soft">
                    {list ? (
                        <>
                            题库共 <span className="numeric font-semibold text-ink">{list.total}</span> 题 · 待抽检{' '}
                            <span className="numeric font-semibold text-beam">{list.extracted}</span> 题
                            {list.blocked > 0 && (
                                <>
                                    {' · 其中 '}
                                    <span className="numeric font-semibold text-[color:var(--color-wrong)]">
                                        {list.blocked}
                                    </span>
                                    {' 题因答案是模型自己算的，暂不发给孩子'}
                                </>
                            )}
                        </>
                    ) : (
                        '加载中…'
                    )}
                </p>
                <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>
                    {loading ? '刷新中…' : '刷新'}
                </Button>
            </div>

            {error && (
                <div className="rounded-[10px] border border-wrong/25 bg-wrong-wash p-4">
                    <p className="text-sm text-wrong">{error}</p>
                </div>
            )}

            {!loading && list && visible.length === 0 && (
                <p className="plate py-10 text-center text-sm text-ink-faint">没有待抽检的题</p>
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
                    onMoveFigure={(to) => void moveFigure(q.id, to)}
                />
            ))}
        </div>
    )
}
