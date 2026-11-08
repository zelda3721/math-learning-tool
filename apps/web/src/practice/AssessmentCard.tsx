import { useCallback, useEffect, useState } from 'react'

import { Button } from '../ui'

/**
 * 阶段测评（前测 / 后测 / 保持率）在孩子端的样子。
 *
 * 三条界面纪律：
 * 1. **不叫考试**：说"看看你现在会到哪儿"，不说分数、不排名；
 * 2. **作答中不给对错**——不然下一道题会被上一道的反馈带跑；
 * 3. 交卷后把参考答案和原文依据一并给出来，那才是这次测评的学习价值。
 */

interface Suggestion {
    kind: 'pre' | 'post' | 'retention'
    why: string
    dueAt?: string
}

interface Question {
    id: string
    stem: string
    options?: string[]
    answerType: string
}

interface Summary {
    id: string
    kind: string
    answered: number
    total: number
    correct: number
    rate: number | null
    items: { questionId: string; correct: boolean | null; reference: string }[]
}

const KIND_LABEL: Record<Suggestion['kind'], string> = {
    pre: '前测',
    post: '后测',
    retention: '保持率检查',
}

export function AssessmentCard({ learnerId }: { learnerId: string }) {
    const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
    const [questions, setQuestions] = useState<Question[] | null>(null)
    const [assessmentId, setAssessmentId] = useState<string | null>(null)
    const [index, setIndex] = useState(0)
    const [answer, setAnswer] = useState('')
    const [busy, setBusy] = useState(false)
    const [summary, setSummary] = useState<Summary | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/v1/assessment/next?learnerId=${encodeURIComponent(learnerId)}`)
            if (!res.ok) return
            const data = (await res.json()) as { suggestion: Suggestion | null }
            setSuggestion(data.suggestion)
        } catch {
            /* 测评是附加项：接口挂了不该挡练习 */
        }
    }, [learnerId])

    useEffect(() => {
        void load()
    }, [load])

    const start = async () => {
        if (!suggestion) return
        setBusy(true)
        setError(null)
        try {
            const res = await fetch('/api/v1/assessment/start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, kind: suggestion.kind }),
            })
            const data = (await res.json()) as { id?: string; questions?: Question[]; error?: string }
            if (!res.ok || !data.id || !data.questions) {
                setError(data.error ?? '这一档测评现在开不了')
                return
            }
            setAssessmentId(data.id)
            setQuestions(data.questions)
            setIndex(0)
            setAnswer('')
        } finally {
            setBusy(false)
        }
    }

    const submitOne = async () => {
        if (!assessmentId || !questions || !answer.trim()) return
        const q = questions[index]
        if (!q) return
        setBusy(true)
        try {
            await fetch(`/api/v1/assessment/${encodeURIComponent(assessmentId)}/answer`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, questionId: q.id, answer: answer.trim() }),
            })
            setAnswer('')
            if (index + 1 < questions.length) setIndex(index + 1)
            else await finish(assessmentId)
        } finally {
            setBusy(false)
        }
    }

    const finish = async (id: string) => {
        const res = await fetch(`/api/v1/assessment/${encodeURIComponent(id)}/finish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ learnerId }),
        })
        const data = (await res.json()) as { summary?: Summary }
        if (data.summary) setSummary(data.summary)
        setQuestions(null)
        setAssessmentId(null)
        setSuggestion(null)
    }

    if (summary) {
        const pct = summary.rate === null ? '—' : `${Math.round(summary.rate * 100)}%`
        return (
            <div className="plate p-6 space-y-3 max-w-lg mx-auto">
                <h3 className="text-lg font-semibold text-ink">
                    {KIND_LABEL[summary.kind as Suggestion['kind']] ?? '测评'}做完了
                </h3>
                <p className="text-sm text-ink-soft">
                    做了 {summary.answered} 道，对了 {summary.correct} 道（{pct}）。
                    这不是分数，是看看你现在会到哪儿。
                </p>
                <ul className="space-y-1 text-sm">
                    {summary.items.map((it) => (
                        <li key={it.questionId} className={it.correct ? 'text-[color:var(--color-correct)]' : 'text-ink-faint'}>
                            {it.correct ? '对' : '再看看'} · 参考答案 {it.reference || '（无）'}
                        </li>
                    ))}
                </ul>
                <Button size="sm" variant="secondary" onClick={() => setSummary(null)}>
                    知道了
                </Button>
            </div>
        )
    }

    if (questions) {
        const q = questions[index]
        return (
            <div className="plate p-6 space-y-3 max-w-lg mx-auto">
                <p className="text-xs text-ink-faint numeric">
                    第 {index + 1} / {questions.length} 道 · 这一档没有提示
                </p>
                <p className="text-sm text-ink whitespace-pre-wrap">{q?.stem}</p>
                {q?.options && q.options.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {q.options.map((opt) => (
                            <Button
                                key={opt}
                                size="sm"
                                variant={answer === opt ? 'primary' : 'secondary'}
                                onClick={() => setAnswer(opt)}
                            >
                                {opt}
                            </Button>
                        ))}
                    </div>
                ) : (
                    <input
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                        placeholder="写下你的答案"
                        className="w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px]"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void submitOne()
                        }}
                    />
                )}
                <Button disabled={busy || !answer.trim()} onClick={() => void submitOne()}>
                    {busy ? '记下……' : index + 1 < questions.length ? '下一道' : '交卷'}
                </Button>
            </div>
        )
    }

    if (!suggestion) return null
    const due = suggestion.dueAt ? new Date(suggestion.dueAt) : null
    const ready = !due || due.getTime() <= Date.now()
    return (
        <div className="plate p-4 max-w-lg mx-auto space-y-2">
            <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">{KIND_LABEL[suggestion.kind]}</h3>
                {due && !ready && (
                    <span className="text-xs text-ink-faint">
                        {due.toISOString().slice(5, 10)} 之后可以来做
                    </span>
                )}
            </div>
            <p className="text-sm text-ink-soft">{suggestion.why}</p>
            {error && <p className="text-sm text-wrong">{error}</p>}
            {ready && (
                <Button size="sm" disabled={busy} onClick={() => void start()}>
                    {busy ? '准备中……' : `做一次${KIND_LABEL[suggestion.kind]}`}
                </Button>
            )}
        </div>
    )
}
