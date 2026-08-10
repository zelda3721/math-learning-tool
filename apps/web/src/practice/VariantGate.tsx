import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
    fetchVariant,
    submitAnswer,
    type MasteryChange,
    type PracticeQuestion,
} from './api'
import { BandBadge } from './badges'
import { Badge, Button } from '../ui'

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
        return <div className="text-center text-ink-faint py-10">正在找一道变式题……</div>
    }

    if (state.kind === 'none' || state.kind === 'error') {
        return (
            <div className="space-y-5 text-center">
                <div className="rounded-[10px] bg-paper border border-rule px-4 py-3 text-ink-soft">
                    {state.kind === 'none' ? state.message : `变式题没取到：${state.message}`}
                </div>
                <Button size="lg" onClick={() => onDone(undefined)}>
                    下一题
                </Button>
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
                <Badge tone="beam">变式题</Badge>
                <span className="text-sm text-ink-faint">换个样子，再试一次</span>
            </div>

            <p className="stem whitespace-pre-wrap">{q.stem}</p>

            {answering &&
                (q.options && q.options.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {q.options.map((opt) => (
                            <Button
                                key={opt}
                                size="lg"
                                variant={answer === opt ? 'primary' : 'secondary'}
                                disabled={submitting}
                                onClick={() => setAnswer(opt)}
                                className="text-left"
                            >
                                {opt}
                            </Button>
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
                        className="input-hero"
                    />
                ))}

            {state.outcome === 'retry' && (
                <div className="rounded-[10px] bg-wrong-wash border border-wrong/25 px-4 py-3 text-wrong font-semibold">
                    还差一点，再试一次！
                </div>
            )}
            {/* 签名时刻：全站唯一编排过的金色 + 点亮动效 —— 这一刻的意思就是「学会了」 */}
            {state.outcome === 'passed' && (
                <div className="star-lit rounded-[14px] bg-lit-wash border border-lit/30 px-4 py-5 text-center space-y-3">
                    <p className="text-xl font-bold text-lit">⭐ 做对了，星星点亮！</p>
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
                <div className="rounded-[10px] bg-paper border border-rule px-4 py-3 text-ink-soft font-medium">
                    没关系，明天再练——这个知识点会再来找你。
                </div>
            )}
            {state.outcome === 'review' && (
                <div className="rounded-[10px] bg-paper border border-rule px-4 py-3 text-ink-soft font-medium">
                    这道题已交给家长确认，先继续下一题吧。
                </div>
            )}
            {error && (
                <div className="rounded-[10px] bg-wrong-wash border border-wrong/25 px-4 py-3 text-wrong text-sm">
                    出了点小问题：{error}，请再试一次。
                </div>
            )}

            <div className="flex flex-wrap justify-center gap-3">
                {answering && (
                    <Button
                        size="lg"
                        onClick={() => void handleSubmit()}
                        disabled={!answer.trim() || submitting}
                    >
                        {submitting ? '批改中……' : state.outcome === 'retry' ? '再交一次' : '交卷'}
                    </Button>
                )}
                {!answering && (
                    <Button
                        size="lg"
                        onClick={() =>
                            onDone(
                                state.outcome === 'passed'
                                    ? true
                                    : state.outcome === 'exhausted'
                                      ? false
                                      : undefined
                            )
                        }
                    >
                        下一题
                    </Button>
                )}
            </div>
        </div>
    )
}
