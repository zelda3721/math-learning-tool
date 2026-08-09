import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
    fetchVariant,
    submitAnswer,
    type MasteryChange,
    type PracticeQuestion,
} from './api'
import { BandBadge } from './badges'

/**
 * 变式关卡：讲完就练一道同类题。做对 → 大庆祝 + 点亮徽章；
 * 做错可重试一次，再错「明天再练」；无变式题 → 展示 server 的排队说明。
 */

type GateState =
    | { kind: 'loading' }
    | { kind: 'none'; message: string }
    | { kind: 'error'; message: string }
    | {
          kind: 'question'
          question: PracticeQuestion
          wrongCount: number
          outcome: 'answering' | 'retry' | 'passed' | 'exhausted' | 'review'
          mastery: MasteryChange[]
      }

interface Props {
    learnerId: string
    /** 原题 id：server 据此找同组/同型/同节点的变式 */
    questionId: string
    /** variantCorrect：true 做对 / false 两次都错 / undefined 没做成（无题或待家长确认） */
    onDone: (variantCorrect: boolean | undefined) => void
}

export function VariantGate({ learnerId, questionId, onDone }: Props) {
    const [state, setState] = useState<GateState>({ kind: 'loading' })
    const [answer, setAnswer] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const startRef = useRef(performance.now())
    const inputRef = useRef<HTMLInputElement | null>(null)

    useEffect(() => {
        let cancelled = false
        void fetchVariant({ learnerId, questionId })
            .then((res) => {
                if (cancelled) return
                if (res.kind === 'none') {
                    setState({ kind: 'none', message: res.message })
                } else {
                    startRef.current = performance.now()
                    setState({
                        kind: 'question',
                        question: res.question,
                        wrongCount: 0,
                        outcome: 'answering',
                        mastery: [],
                    })
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
                }
            })
        return () => {
            cancelled = true
        }
    }, [learnerId, questionId])

    if (state.kind === 'loading') {
        return <div className="text-center text-slate-400 py-10">正在找一道变式题……</div>
    }

    if (state.kind === 'none' || state.kind === 'error') {
        return (
            <div className="space-y-5 text-center">
                <div className="rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3 text-slate-600">
                    {state.kind === 'none' ? state.message : `变式题没取到：${state.message}`}
                </div>
                <button
                    type="button"
                    onClick={() => onDone(undefined)}
                    className="px-8 py-3 rounded-2xl bg-emerald-500 text-white text-lg font-bold shadow-lg shadow-emerald-200 hover:bg-emerald-600 transition-colors"
                >
                    下一题
                </button>
            </div>
        )
    }

    const q = state.question
    const answering = state.outcome === 'answering' || state.outcome === 'retry'

    const handleSubmit = async () => {
        const trimmed = answer.trim()
        if (!trimmed || submitting || !answering) return
        setSubmitting(true)
        setError(null)
        try {
            const result = await submitAnswer({
                learnerId,
                questionId: q.id,
                answer: trimmed,
                hintLevelUsed: 0,
                durationS: Math.round((performance.now() - startRef.current) / 100) / 10,
                source: 'variant',
            })
            setState((prev) => {
                if (prev.kind !== 'question') return prev
                const mastery = [...prev.mastery, ...result.mastery]
                if (result.needsReview) return { ...prev, mastery, outcome: 'review' }
                if (result.correct) return { ...prev, mastery, outcome: 'passed' }
                const wrongCount = prev.wrongCount + 1
                return { ...prev, mastery, wrongCount, outcome: wrongCount >= 2 ? 'exhausted' : 'retry' }
            })
            if (!result.correct && !result.needsReview) {
                setAnswer('')
                inputRef.current?.focus()
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSubmitting(false)
        }
    }

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            void handleSubmit()
        }
    }

    // 点亮徽章：每个节点取最后一次变化
    const litBands = [...new Map(state.mastery.map((m) => [m.nodeId, m])).values()]

    return (
        <div className="space-y-5">
            <div className="flex items-center justify-center gap-2">
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-violet-100 text-violet-600 border-violet-200">
                    变式题
                </span>
                <span className="text-sm text-slate-400">换个样子，再试一次</span>
            </div>

            <p className="text-xl md:text-2xl font-semibold text-slate-700 leading-relaxed whitespace-pre-wrap">
                {q.stem}
            </p>

            {answering &&
                (q.options && q.options.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {q.options.map((opt) => (
                            <button
                                key={opt}
                                type="button"
                                disabled={submitting}
                                onClick={() => setAnswer(opt)}
                                className={`px-4 py-3 rounded-2xl border-2 text-left text-lg font-medium transition-colors disabled:cursor-not-allowed ${
                                    answer === opt
                                        ? 'border-violet-400 bg-violet-50 text-violet-700'
                                        : 'border-slate-100 bg-white text-slate-600 hover:border-violet-200'
                                }`}
                            >
                                {opt}
                            </button>
                        ))}
                    </div>
                ) : (
                    <input
                        ref={inputRef}
                        type="text"
                        autoFocus
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="在这里写答案，按回车提交"
                        className="w-full px-5 py-4 text-xl bg-white border-2 border-slate-100 rounded-2xl placeholder:text-slate-300 text-slate-700 focus:outline-none focus:border-violet-400 focus:ring-4 focus:ring-violet-100 transition-all"
                    />
                ))}

            {state.outcome === 'retry' && (
                <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-red-600 font-semibold">
                    还差一点，再试一次！
                </div>
            )}
            {state.outcome === 'passed' && (
                <div className="rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-4 text-center space-y-2">
                    <p className="text-xl font-bold text-emerald-600">⭐ 做对了，星星点亮！</p>
                    {litBands.length > 0 && (
                        <div className="flex flex-wrap justify-center gap-1.5">
                            {litBands.map((m) => (
                                <BandBadge key={m.nodeId} band={m.band} />
                            ))}
                        </div>
                    )}
                </div>
            )}
            {state.outcome === 'exhausted' && (
                <div className="rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3 text-slate-600 font-medium">
                    没关系，明天再练——这个知识点会再来找你。
                </div>
            )}
            {state.outcome === 'review' && (
                <div className="rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3 text-slate-600 font-medium">
                    这道题已交给家长确认，先继续下一题吧。
                </div>
            )}
            {error && (
                <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-red-500 text-sm">
                    出了点小问题：{error}，请再试一次。
                </div>
            )}

            <div className="flex flex-wrap justify-center gap-3">
                {answering && (
                    <button
                        type="button"
                        onClick={() => void handleSubmit()}
                        disabled={!answer.trim() || submitting}
                        className="px-8 py-3 rounded-2xl bg-violet-500 text-white text-lg font-bold shadow-lg shadow-violet-200 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                        {submitting ? '批改中……' : state.outcome === 'retry' ? '再交一次' : '交卷'}
                    </button>
                )}
                {!answering && (
                    <button
                        type="button"
                        onClick={() =>
                            onDone(
                                state.outcome === 'passed'
                                    ? true
                                    : state.outcome === 'exhausted'
                                      ? false
                                      : undefined
                            )
                        }
                        className="px-8 py-3 rounded-2xl bg-emerald-500 text-white text-lg font-bold shadow-lg shadow-emerald-200 hover:bg-emerald-600 transition-colors"
                    >
                        下一题
                    </button>
                )}
            </div>
        </div>
    )
}
