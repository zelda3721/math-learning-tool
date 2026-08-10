import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import {
    diagnoseAttempt,
    fetchHint,
    submitAnswer,
    submitPhoto,
    type DiagnosisResult,
    type HintResult,
    type MasteryChange,
    type TodayItem,
} from './api'
import { SlotBadge } from './badges'
import { DiagnosisCard } from './DiagnosisCard'
import { ExplanationView } from './ExplanationView'
import { VariantGate } from './VariantGate'

export interface QuestionRecord {
    questionId: string
    /** 最终是否答对（needsReview 的主观题不计对错） */
    correct: boolean
    review: boolean
    skipped: boolean
    /** 用到的最高提示级别（也是本题提示次数：级别逐级 +1） */
    hintLevel: number
    /** 本题所有 submit 返回的掌握度变化，按时间顺序 */
    mastery: MasteryChange[]
    /** 本题走过归因流程（错→归因→讲解→变式的核心闭环） */
    diagnosed?: boolean
    /** 变式题结果：true 做对 / false 两次都错 / undefined 没做（跳过或无题） */
    variantCorrect?: boolean
}

type Feedback =
    | { kind: 'correct' }
    | { kind: 'review' }
    | { kind: 'wrong'; canHint: boolean }
    | null

/** 501 后整个会话隐藏拍照入口（内存 flag，刷新页面重试） */
let photoUnavailable = false

function readAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
        reader.readAsDataURL(file)
    })
}

/** 错后闭环阶段：answering →（先跳过）diagnosing → diagnosed → explaining/variant → done */
type Flow =
    | { kind: 'answering' }
    | { kind: 'diagnosing' }
    | { kind: 'diagnosed'; diagnosis: DiagnosisResult }
    | { kind: 'explaining'; diagnosis: DiagnosisResult }
    | { kind: 'variant'; diagnosis: DiagnosisResult }

interface Props {
    item: TodayItem
    index: number
    total: number
    learnerId: string
    onDone: (record: QuestionRecord) => void
}

export function QuestionCard({ item, index, total, learnerId, onDone }: Props) {
    const q = item.question
    const [answer, setAnswer] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [feedback, setFeedback] = useState<Feedback>(null)
    const [hintLevel, setHintLevel] = useState(0)
    const [hints, setHints] = useState<HintResult[]>([])
    const [hintLoading, setHintLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [flow, setFlow] = useState<Flow>({ kind: 'answering' })
    const startRef = useRef(performance.now())
    const masteryRef = useRef<MasteryChange[]>([])
    const lastWrongRef = useRef<string | undefined>(undefined)
    const lastAttemptIdRef = useRef<string | undefined>(undefined)
    const inputRef = useRef<HTMLInputElement | null>(null)
    const fileRef = useRef<HTMLInputElement | null>(null)
    const [photoEnabled, setPhotoEnabled] = useState(!photoUnavailable)
    const [photoSubmitting, setPhotoSubmitting] = useState(false)

    // 换题时整体重置（key 由父组件保证，这里兜底同步计时起点）
    useEffect(() => {
        startRef.current = performance.now()
    }, [q.id])

    const finished = feedback?.kind === 'correct' || feedback?.kind === 'review'
    const wrongExhausted = feedback?.kind === 'wrong' && hintLevel >= 3

    const handleSubmit = async () => {
        const trimmed = answer.trim()
        if (!trimmed || submitting || finished) return
        setSubmitting(true)
        setError(null)
        try {
            const result = await submitAnswer({
                learnerId,
                questionId: q.id,
                answer: trimmed,
                hintLevelUsed: hintLevel,
                durationS: Math.round((performance.now() - startRef.current) / 100) / 10,
                queueItemId: item.queueItemId,
                reviewCardId: item.reviewCardId,
            })
            masteryRef.current.push(...result.mastery)
            if (result.needsReview) {
                setFeedback({ kind: 'review' })
            } else if (result.correct) {
                setFeedback({ kind: 'correct' })
            } else {
                lastWrongRef.current = trimmed
                lastAttemptIdRef.current = result.attemptId
                setFeedback({ kind: 'wrong', canHint: result.hintAvailable })
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSubmitting(false)
        }
    }

    /** 拍照作答：dataURL → vision 判卷。confident 结果同键入作答；低置信度进家长抽检。 */
    const handlePhotoChange = async (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file || photoSubmitting || submitting || finished) return
        setPhotoSubmitting(true)
        setError(null)
        try {
            const image = await readAsDataURL(file)
            const res = await submitPhoto({
                learnerId,
                questionId: q.id,
                image,
                hintLevelUsed: hintLevel,
                durationS: Math.round((performance.now() - startRef.current) / 100) / 10,
                queueItemId: item.queueItemId,
                reviewCardId: item.reviewCardId,
            })
            if (res.status === 'unconfigured') {
                photoUnavailable = true
                setPhotoEnabled(false)
                setError('拍照判卷需要配置视觉模型')
                return
            }
            const result = res.result
            masteryRef.current.push(...result.mastery)
            if (result.extractedAnswer) setAnswer(result.extractedAnswer)
            if (result.needsReview) {
                setFeedback({ kind: 'review' })
            } else if (result.correct) {
                setFeedback({ kind: 'correct' })
            } else {
                lastWrongRef.current = result.extractedAnswer || undefined
                lastAttemptIdRef.current = result.attemptId
                setFeedback({ kind: 'wrong', canHint: result.hintAvailable })
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setPhotoSubmitting(false)
        }
    }

    const handleHint = async () => {
        if (hintLoading || hintLevel >= 3) return
        const level = hintLevel + 1
        setHintLoading(true)
        setError(null)
        try {
            const result = await fetchHint({
                learnerId,
                questionId: q.id,
                level,
                lastWrongAnswer: lastWrongRef.current,
            })
            setHints((prev) => [...prev, result])
            setHintLevel(level)
            setFeedback(null)
            inputRef.current?.focus()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setHintLoading(false)
        }
    }

    const makeRecord = (
        skipped: boolean,
        extra?: { diagnosed?: boolean; variantCorrect?: boolean }
    ): QuestionRecord => ({
        questionId: q.id,
        correct: feedback?.kind === 'correct',
        review: feedback?.kind === 'review',
        skipped,
        hintLevel,
        mastery: masteryRef.current,
        ...extra,
    })

    /** L3 提示后仍错点「先跳过」→ 进入归因流程；归因失败则退回原来的直接跳过 */
    const startDiagnosis = async () => {
        const attemptId = lastAttemptIdRef.current
        if (!attemptId) {
            onDone(makeRecord(true))
            return
        }
        setFlow({ kind: 'diagnosing' })
        try {
            const diagnosis = await diagnoseAttempt(attemptId)
            setFlow({ kind: 'diagnosed', diagnosis })
        } catch {
            onDone(makeRecord(true))
        }
    }

    /** 闭环收尾：记录 diagnosed / variantCorrect，交给父组件进入下一题 */
    const finishFlow = (variantCorrect: boolean | undefined) => {
        onDone(makeRecord(true, { diagnosed: true, variantCorrect }))
    }

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault()
            void handleSubmit()
        }
    }

    return (
        <div className="soft-glass p-6 md:p-8 space-y-6">
            {/* 进度 + 槽位 */}
            <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-400">
                    第 <span className="text-sky-500 text-lg">{index + 1}</span> / {total} 题
                </span>
                <SlotBadge slot={item.slot} />
            </div>

            {/* 错后闭环：归因中 / 归因卡 / 讲解 / 变式 */}
            {flow.kind === 'diagnosing' && (
                <div className="text-center text-slate-400 py-10">正在看看你卡在哪儿……</div>
            )}
            {flow.kind === 'diagnosed' && (
                <DiagnosisCard
                    diagnosis={flow.diagnosis}
                    onExplain={() => setFlow({ kind: 'explaining', diagnosis: flow.diagnosis })}
                    onVariant={() => setFlow({ kind: 'variant', diagnosis: flow.diagnosis })}
                />
            )}
            {flow.kind === 'explaining' && (
                <ExplanationView
                    request={{
                        learnerId,
                        questionId: q.id,
                        mistakeId: flow.diagnosis.mistakeId,
                        focusNodeId: flow.diagnosis.rootNodeId,
                        misconceptionId: flow.diagnosis.misconceptionId,
                    }}
                    primaryLabel="去做变式题"
                    onPrimary={() => setFlow({ kind: 'variant', diagnosis: flow.diagnosis })}
                    onSkip={() => finishFlow(undefined)}
                />
            )}
            {flow.kind === 'variant' && (
                <VariantGate
                    learnerId={learnerId}
                    questionId={q.id}
                    onDone={(variantCorrect) => finishFlow(variantCorrect)}
                />
            )}

            {flow.kind === 'answering' && (
                <>
            {/* 题干 */}
            <p className="text-xl md:text-2xl font-semibold text-slate-700 leading-relaxed whitespace-pre-wrap">
                {q.stem}
            </p>

            {/* 提示气泡 */}
            {hints.map((h) => (
                <div
                    key={h.level}
                    className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-amber-800"
                >
                    <span className="text-xs font-bold text-amber-500 mr-2">提示 {h.level}</span>
                    <span className="whitespace-pre-wrap">{h.hint}</span>
                </div>
            ))}

            {/* 作答区 */}
            {q.options && q.options.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {q.options.map((opt) => (
                        <button
                            key={opt}
                            type="button"
                            disabled={finished || submitting}
                            onClick={() => setAnswer(opt)}
                            className={`px-4 py-3 rounded-2xl border-2 text-left text-lg font-medium transition-colors disabled:cursor-not-allowed ${
                                answer === opt
                                    ? 'border-sky-400 bg-sky-50 text-sky-700'
                                    : 'border-slate-100 bg-white text-slate-600 hover:border-sky-200'
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
                    disabled={finished}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={q.answerType === 'steps' ? '写下你的做法和结果' : '在这里写答案，按回车提交'}
                    className="w-full px-5 py-4 text-xl bg-white border-2 border-slate-100 rounded-2xl placeholder:text-slate-300 text-slate-700 focus:outline-none focus:border-sky-400 focus:ring-4 focus:ring-sky-100 transition-all disabled:bg-slate-50"
                />
            )}

            {/* 反馈条 */}
            {feedback?.kind === 'correct' && (
                <div className="rounded-2xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-emerald-700 font-semibold">
                    答对啦！真棒！
                </div>
            )}
            {feedback?.kind === 'review' && (
                <div className="rounded-2xl bg-slate-50 border border-slate-200 px-4 py-3 text-slate-600 font-medium">
                    这道题已交给家长确认，先继续下一题吧。
                </div>
            )}
            {feedback?.kind === 'wrong' && (
                <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-red-600 font-semibold">
                    {wrongExhausted ? '还是不太对，这道题先放一放。' : '再想想，你可以改一改答案再交。'}
                </div>
            )}
            {error && (
                <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-red-500 text-sm">
                    出了点小问题：{error}，请再试一次。
                </div>
            )}

            {/* 操作区 */}
            <div className="flex flex-wrap gap-3">
                {!finished && (
                    <button
                        type="button"
                        onClick={() => void handleSubmit()}
                        disabled={!answer.trim() || submitting}
                        className="px-8 py-3 rounded-2xl bg-sky-500 text-white text-lg font-bold shadow-lg shadow-sky-200 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                        {submitting ? '批改中……' : feedback?.kind === 'wrong' ? '再交一次' : '交卷'}
                    </button>
                )}
                {!finished && photoEnabled && (
                    <>
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            capture="environment"
                            className="hidden"
                            onChange={(e) => void handlePhotoChange(e)}
                        />
                        <button
                            type="button"
                            onClick={() => fileRef.current?.click()}
                            disabled={submitting || photoSubmitting}
                            className="px-6 py-3 rounded-2xl bg-white border-2 border-slate-100 text-slate-600 text-lg font-bold hover:border-sky-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            {photoSubmitting ? '识别中……' : '📷 拍照上传'}
                        </button>
                    </>
                )}
                {feedback?.kind === 'wrong' && feedback.canHint && hintLevel < 3 && (
                    <button
                        type="button"
                        onClick={() => void handleHint()}
                        disabled={hintLoading}
                        className="px-6 py-3 rounded-2xl bg-amber-400 text-white text-lg font-bold shadow-lg shadow-amber-200 hover:bg-amber-500 disabled:opacity-40 transition-colors"
                    >
                        {hintLoading ? '提示生成中……' : `要提示吗 (${hintLevel + 1}/3)`}
                    </button>
                )}
                {finished && (
                    <button
                        type="button"
                        onClick={() => onDone(makeRecord(false))}
                        className="px-8 py-3 rounded-2xl bg-emerald-500 text-white text-lg font-bold shadow-lg shadow-emerald-200 hover:bg-emerald-600 transition-colors"
                    >
                        下一题
                    </button>
                )}
                {wrongExhausted && (
                    <button
                        type="button"
                        onClick={() => void startDiagnosis()}
                        className="px-6 py-3 rounded-2xl bg-slate-400 text-white text-lg font-bold shadow-lg shadow-slate-200 hover:bg-slate-500 transition-colors"
                    >
                        先跳过
                    </button>
                )}
            </div>
                </>
            )}
        </div>
    )
}
