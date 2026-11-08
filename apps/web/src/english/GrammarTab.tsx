import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, ErrorState, LoadingState } from '../ui'

/**
 * 英语语法（阶段 5）：单元 → 学一学 / 练一练。
 *
 * 单元来自教材本身：115 个单元，标题就是语法点，顺序就是学习顺序，
 * 每个单元能翻回原书页码。这里不造第二条判卷通路——
 * 题走既有的 /practice/submit（source=daily），规则判卷、掌握度、复习卡全都照常。
 *
 * 为什么不把语法藏在「课堂」里：语法是英语的主干之一，孩子应该能在英语页直接找到
 * "这一单元讲什么、我练到哪儿了"，而不是先知道要去另一个模块翻知识点列表。
 */

interface Unit {
    id: string
    name: string
    stage: string
    order: number
    questionCount: number
    summary: string
}

interface UnitQuestion {
    id: string
    stem: string
    options?: string[]
    answerType: string
}

interface UnitDetail {
    unit: { id: string; name: string; stage: string; summary: string; whatIsIt?: string }
    questions: UnitQuestion[]
    lessonAvailable: boolean
}

interface SubmitResult {
    correct: boolean
    needsReview: boolean
    verification?: string
    notAnAnswer?: boolean
    countedTowardMastery?: boolean
    hintAvailable?: boolean
    repeat?: boolean
}

/** 课堂要按这个单元开课：把节点 id 交给课堂页（同一个标签页里跳过去） */
function openLesson(nodeId: string) {
    try {
        window.localStorage.setItem('mathtutor:classroom:prefill', nodeId)
    } catch {
        /* 隐私模式写不进去：跳过去手动选也一样 */
    }
    window.dispatchEvent(new CustomEvent('mathtutor:navigate', { detail: { view: 'classroom' } }))
}

export function GrammarTab({ learnerId }: { learnerId: string }) {
    const [units, setUnits] = useState<Unit[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [picked, setPicked] = useState<UnitDetail | null>(null)
    const [answering, setAnswering] = useState<{ index: number; value: string } | null>(null)
    const [feedback, setFeedback] = useState<{ ok: boolean; note: string } | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback(async () => {
        setError(null)
        try {
            const res = await fetch(`/api/v1/en/grammar/units?learnerId=${encodeURIComponent(learnerId)}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as { units: Unit[] }
            setUnits(data.units)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        setUnits(null)
        setPicked(null)
        void load()
    }, [load])

    const openUnit = async (id: string) => {
        setBusy(true)
        setError(null)
        setFeedback(null)
        try {
            const res = await fetch(
                `/api/v1/en/grammar/unit/${encodeURIComponent(id)}?learnerId=${encodeURIComponent(learnerId)}`,
            )
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setPicked((await res.json()) as UnitDetail)
            setAnswering({ index: 0, value: '' })
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const submit = async () => {
        if (!answering || !picked) return
        const q = picked.questions[answering.index]
        const value = answering.value.trim()
        if (!q || !value) return
        setBusy(true)
        try {
            const res = await fetch('/api/v1/practice/submit', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, questionId: q.id, answer: value, source: 'daily' }),
            })
            const data = (await res.json()) as SubmitResult & { error?: string }
            if (!res.ok) {
                setFeedback({ ok: false, note: data.error ?? `HTTP ${res.status}` })
                return
            }
            if (data.notAnAnswer) {
                setFeedback({ ok: false, note: '这还不算作答——再想想，或者看看这一单元的讲解。' })
                return
            }
            if (data.needsReview) {
                setFeedback({ ok: false, note: '这句系统判不准，已经交给家长看一眼；你可以再写一次。' })
                return
            }
            setFeedback({
                ok: data.correct,
                note: data.correct
                    ? data.verification === 'ai_unverified'
                        ? '这次是 AI 判断的，不计入掌握度。'
                        : '对了！'
                    : '还不对——回到这一单元讲的那句话上看一眼。',
            })
            if (data.correct) {
                const next = answering.index + 1
                if (next < picked.questions.length) setAnswering({ index: next, value: '' })
            }
        } catch (err) {
            setFeedback({ ok: false, note: err instanceof Error ? err.message : String(err) })
        } finally {
            setBusy(false)
        }
    }

    const filtered = useMemo(() => {
        if (!units) return []
        const q = query.trim().toLowerCase()
        if (!q) return units.slice(0, 40)
        return units.filter((u) => u.name.toLowerCase().includes(q) || u.summary?.toLowerCase().includes(q)).slice(0, 40)
    }, [units, query])

    if (error) return <ErrorState message={`语法单元加载失败：${error}`} onRetry={() => void load()} />
    if (!units) return <LoadingState text="正在取语法单元……" />

    if (picked) {
        const q = answering ? picked.questions[answering.index] : undefined
        return (
            <div className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                        <p className="font-semibold text-ink">{picked.unit.name}</p>
                        <p className="text-xs text-ink-faint">{picked.unit.summary}</p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => { setPicked(null); setFeedback(null) }}>
                        返回单元列表
                    </Button>
                </div>

                <div className="rounded-[10px] border border-rule bg-paper px-4 py-3 space-y-2">
                    <p className="text-sm text-ink-soft">
                        {picked.unit.whatIsIt ?? '这一单元讲一个语法点：先看老师讲，再做两道题确认自己会了。'}
                    </p>
                    <Button size="sm" variant="secondary" onClick={() => openLesson(picked.unit.id)}>
                        听老师讲这一课
                    </Button>
                </div>

                {picked.questions.length === 0 ? (
                    <p className="text-sm text-ink-faint">这个单元暂时没有配套的练习题——先看看讲解。</p>
                ) : q && answering ? (
                    <div className="plate p-5 space-y-3">
                        <p className="text-xs text-ink-faint numeric">
                            第 {answering.index + 1} / {picked.questions.length} 题
                        </p>
                        <p className="text-sm text-ink whitespace-pre-wrap">{q.stem}</p>
                        {q.options && q.options.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                                {q.options.map((opt) => (
                                    <Button
                                        key={opt}
                                        size="sm"
                                        variant={answering.value === opt ? 'primary' : 'secondary'}
                                        onClick={() => setAnswering({ ...answering, value: opt })}
                                    >
                                        {opt}
                                    </Button>
                                ))}
                            </div>
                        ) : (
                            <input
                                value={answering.value}
                                onChange={(e) => setAnswering({ ...answering, value: e.target.value })}
                                placeholder="写下这一空该填的词"
                                className="w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px]"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') void submit()
                                }}
                            />
                        )}
                        <Button disabled={busy || !answering.value.trim()} onClick={() => void submit()}>
                            {busy ? '批改中…' : '交卷'}
                        </Button>
                        {feedback && (
                            <p className={`text-sm ${feedback.ok ? 'text-[color:var(--color-correct)]' : 'text-wrong'}`}>
                                {feedback.note}
                            </p>
                        )}
                    </div>
                ) : (
                    <p className="text-sm text-[color:var(--color-correct)]">这个单元的题都做对了。</p>
                )}
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <p className="text-sm text-ink-soft">
                按教材的顺序学语法：点开一个单元看讲解，再做两道题确认自己会了。
            </p>
            <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜单元名，比如 am/is/are、过去时"
                className="w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px]"
            />
            <ul className="grid gap-2 md:grid-cols-2">
                {filtered.map((u) => (
                    <li key={u.id} className="plate p-4 space-y-1">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="font-semibold text-ink">{u.name}</span>
                            <span className="text-xs text-ink-faint numeric">{u.questionCount} 道题</span>
                        </div>
                        <p className="text-xs text-ink-faint line-clamp-2">{u.summary}</p>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void openUnit(u.id)}>
                            学这一单元
                        </Button>
                    </li>
                ))}
            </ul>
            {filtered.length === 0 && <p className="text-sm text-ink-faint">没有匹配的单元，换个说法试试。</p>}
        </div>
    )
}
