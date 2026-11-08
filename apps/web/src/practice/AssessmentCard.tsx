import { useCallback, useEffect, useState } from 'react'
import type { FigureSpec } from '@mathtutor/explainer-web'

import { Badge, Button, MathText } from '../ui'
import {
    TIMEOUTS,
    assessmentAnswerOutcome,
    assessmentStartError,
    firstUnansweredIndex,
    requestJson,
} from '../english/uiLogic'
import { QuestionFigure } from './QuestionFigure'
import { QuestionImage } from './QuestionImage'

/**
 * 阶段测评（前测 / 后测 / 保持率）在孩子端的样子。
 *
 * 三条界面纪律：
 * 1. **不叫考试**：说"看看你现在会到哪儿"，不说分数、不排名；
 * 2. **作答中不给对错**——不然下一道题会被上一道的反馈带跑；
 * 3. 交卷后把参考答案和原文依据一并给出来，那才是这次测评的学习价值。
 *
 * 一条记账纪律：作答没送到服务端就**停在这一题**让他重交——
 * 早先不看返回就往下走，失败的题悄悄从分母里消失，"做了 8 道"其实只记了 6 道。
 */

interface Suggestion {
    kind: 'pre' | 'post' | 'retention'
    why: string
    dueAt?: string
}

interface Question {
    id: string
    stem: string
    /** 双语题的英文题面：和练习里一样，英文在前、中文当退路 */
    stemEn?: string
    /** 原题原图文件名：走 /api/v1/figures/:name（QuestionImage 拼） */
    figureImage?: string
    figure?: FigureSpec
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
        const r = await requestJson<{ suggestion: Suggestion | null }>(
            `/api/v1/assessment/next?learnerId=${encodeURIComponent(learnerId)}`,
            {},
            { timeoutMs: TIMEOUTS.assessment, timeoutMessage: '' },
        )
        // 测评是附加项：接口挂了不该挡练习，静默不显示
        if (r.ok) setSuggestion(r.data.suggestion)
    }, [learnerId])

    useEffect(() => {
        void load()
    }, [load])

    const start = async () => {
        if (!suggestion || busy) return
        setBusy(true)
        setError(null)
        const r = await requestJson<{ id?: string; questions?: Question[]; resumed?: boolean; answeredIds?: string[] }>(
            '/api/v1/assessment/start',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, kind: suggestion.kind }),
            },
            { timeoutMs: TIMEOUTS.assessment, timeoutMessage: '准备题目太久了，再点一次试试' },
        )
        setBusy(false)
        if (!r.ok) {
            // 403 家长账号 / 409 没到时间或已做过：说人话，不说"HTTP 409"；超时 / 断网用请求层的那句
            setError(r.status === 0 ? r.error : assessmentStartError(r.status, r.data?.error))
            return
        }
        if (!r.data.id || !r.data.questions) {
            setError(assessmentStartError(r.status, null))
            return
        }
        // 续做没交卷的那份：从第一道没答的接着来；都答过了就直接交卷
        const startAt = r.data.resumed
            ? firstUnansweredIndex(r.data.questions.map((q) => q.id), r.data.answeredIds)
            : 0
        if (startAt === null) {
            setBusy(true)
            await finish(r.data.id)
            setBusy(false)
            return
        }
        setAssessmentId(r.data.id)
        setQuestions(r.data.questions)
        setIndex(startAt)
        setAnswer('')
    }

    const submitOne = async () => {
        if (!assessmentId || !questions || !answer.trim() || busy) return
        const q = questions[index]
        if (!q) return
        setBusy(true)
        setError(null)
        const r = await requestJson<{ ok?: boolean }>(
            `/api/v1/assessment/${encodeURIComponent(assessmentId)}/answer`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, questionId: q.id, answer: answer.trim() }),
            },
            { timeoutMs: TIMEOUTS.assessment, timeoutMessage: '这一题没送出去（等太久了），再交一次' },
        )
        const outcome = assessmentAnswerOutcome(r)
        if (outcome === 'finished') {
            // 这份已经交过卷（比如在别的标签页）：不再答，直接取结果
            await finish(assessmentId)
            setBusy(false)
            return
        }
        if (outcome === 'retry') {
            // 停在这一题、答案留在框里：没记下的题不能悄悄算"做过了"
            setError(`这一题没记下：${r.ok ? '服务没回话' : r.error}。再交一次就好。`)
            setBusy(false)
            return
        }
        if (index + 1 < questions.length) {
            setAnswer('')
            setIndex(index + 1)
            setBusy(false)
            return
        }
        // 最后一题：交卷失败时答案留着，再点一次会先得到 409（已作答）再重新交卷
        await finish(assessmentId)
        setBusy(false)
    }

    const finish = async (id: string) => {
        const r = await requestJson<{ summary?: Summary }>(
            `/api/v1/assessment/${encodeURIComponent(id)}/finish`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId }),
            },
            { timeoutMs: TIMEOUTS.assessment, timeoutMessage: '交卷等太久了，再点一次「交卷」' },
        )
        if (!r.ok || !r.data.summary) {
            // 409 = 答得不到一半：服务端那句话说清楚了还差几道，原样给孩子看（r.error 就是它）
            setError(r.ok ? '交卷没成功，再点一次「交卷」' : r.status === 409 ? r.error : `交卷没成功：${r.error}`)
            return
        }
        setSummary(r.data.summary)
        setAnswer('')
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
                {q?.stemEn && (
                    <div>
                        <p className="text-sm text-ink whitespace-pre-wrap">
                            <MathText>{q.stemEn}</MathText>
                        </p>
                        <p className="mt-1 text-xs text-ink-faint">
                            <Badge tone="sky">英文题面</Badge>
                        </p>
                    </div>
                )}
                <p className={`whitespace-pre-wrap ${q?.stemEn ? 'text-xs text-ink-soft' : 'text-sm text-ink'}`}>
                    <MathText>{q?.stem ?? ''}</MathText>
                </p>
                {/* 配图是题面的一部分：几何题没图读不懂。原图优先，没有才用解算出来的矢量图（同 QuestionCard） */}
                {q?.figureImage ? (
                    <QuestionImage name={q.figureImage} />
                ) : q?.figure ? (
                    <QuestionFigure figure={q.figure} />
                ) : null}
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
                {error && <p className="text-sm text-wrong">{error}</p>}
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
