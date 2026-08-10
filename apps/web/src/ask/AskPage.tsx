/**
 * 「问一道题」：题库外的题也走练习页那套纪律——
 * 先自己作答 → 判卷 → 答错走提示阶梯 L1→L3 → 仍错才给讲解 → 做对变式题才点亮。
 *
 * 自由文本 → POST /ask（引擎 Solve→Verify 出可信答案）→ 一道临时题目 →
 * 直接交给 QuestionCard，整套闭环（判卷/提示/拍照/归因/讲解/变式）原样复用，一行都不重写。
 */
import { useEffect, useRef, useState } from 'react'
import { useLearner } from '../learner/LearnerContext'
import { LearnerGate, LearnerSwitcher } from '../practice/LearnerGate'
import { QuestionCard, type QuestionRecord } from '../practice/QuestionCard'
import { askQuestion, fetchAskJob, type PracticeQuestion, type TodayItem } from '../practice/api'
import { Badge, Button, ErrorState, PageHeader } from '../ui'

type Phase =
    | { kind: 'input' }
    | { kind: 'preparing'; jobId: string; startedAt: number }
    | { kind: 'ready'; item: TodayItem; isNew: boolean }
    | { kind: 'done'; record: QuestionRecord }
    | { kind: 'error'; message: string }

/** 轮询间隔与 ExplanationView 同：3s。 */
const POLL_MS = 3000
/** 连续这么多次拿不到任务状态才判失败（几分钟的长任务，容一次网络抖动） */
const MAX_POLL_ERRORS = 3

function toItem(question: PracticeQuestion): TodayItem {
    return { slot: 'asked', question }
}

export function AskPage() {
    const { learner } = useLearner()
    const [problem, setProblem] = useState('')
    const [phase, setPhase] = useState<Phase>({ kind: 'input' })
    const [submitting, setSubmitting] = useState(false)
    // 等待计时只靠这个时钟推进：等几分钟时，看得见秒数在走才不慌
    const [now, setNow] = useState(() => Date.now())

    const learnerId = learner?.id
    // 换人后回到输入态，避免把上一个孩子的题带过去
    useEffect(() => {
        setPhase({ kind: 'input' })
        setProblem('')
    }, [learnerId])

    const jobId = phase.kind === 'preparing' ? phase.jobId : undefined
    const pollErrorsRef = useRef(0)

    // 任务轮询 + 等待计时（题目要先被解出来并验算，几分钟属正常）
    useEffect(() => {
        if (!jobId) return
        let cancelled = false
        pollErrorsRef.current = 0
        const tick = window.setInterval(() => setNow(Date.now()), 1000)
        const timer = window.setInterval(() => {
            void fetchAskJob(jobId)
                .then((job) => {
                    if (cancelled) return
                    pollErrorsRef.current = 0
                    if (job.status === 'done' && job.question) {
                        setPhase({ kind: 'ready', item: toItem(job.question), isNew: true })
                    } else if (job.status === 'done' || job.status === 'failed') {
                        setPhase({
                            kind: 'error',
                            message: job.error || '这道题暂时没读懂，换个说法或拆开问问看。',
                        })
                    }
                })
                .catch((err) => {
                    if (cancelled) return
                    pollErrorsRef.current += 1
                    if (pollErrorsRef.current >= MAX_POLL_ERRORS) {
                        setPhase({
                            kind: 'error',
                            message: err instanceof Error ? err.message : String(err),
                        })
                    }
                })
        }, POLL_MS)
        return () => {
            cancelled = true
            window.clearInterval(timer)
            window.clearInterval(tick)
        }
    }, [jobId])

    if (!learner) return <LearnerGate />

    const submit = async () => {
        const trimmed = problem.trim()
        if (!trimmed || submitting) return
        setSubmitting(true)
        try {
            const res = await askQuestion({ learnerId: learner.id, problem: trimmed, grade: learner.level })
            if (res.status === 'ready') {
                setPhase({ kind: 'ready', item: toItem(res.question), isNew: res.isNew })
            } else {
                setPhase({ kind: 'preparing', jobId: res.jobId, startedAt: Date.now() })
            }
        } catch (err) {
            setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        } finally {
            setSubmitting(false)
        }
    }

    const askAnother = () => {
        setProblem('')
        setPhase({ kind: 'input' })
    }

    const backToPractice = () => {
        window.dispatchEvent(new CustomEvent('mathtutor:navigate', { detail: { view: 'practice' } }))
    }

    return (
        <div className="space-y-2">
            <PageHeader title="问一道题" subtitle="遇到不会的题？先自己试一次，再一起把它弄懂" />
            <LearnerSwitcher disabled={phase.kind === 'ready' || phase.kind === 'preparing'} />

            {phase.kind === 'input' && (
                <div className="space-y-4">
                    {/* 产品承诺：先讲清规矩，再让他输入 */}
                    <div className="rounded-[10px] bg-beam-wash border border-beam/20 px-5 py-4">
                        <p className="eyebrow mb-1.5">先说好</p>
                        <p className="text-ink font-semibold leading-relaxed">
                            这里不会直接给答案——你先做一次，做不出来我们一步步来。
                        </p>
                        <p className="text-sm text-ink-soft mt-2 leading-relaxed">
                            先自己写答案 → 我来判卷 → 错了给
                            <span className="numeric"> 3 </span>
                            级提示 → 还不会才讲给你听 → 最后做一道变式题，做对才算真的会。
                        </p>
                    </div>

                    <div className="plate p-6 md:p-8 space-y-4">
                        <label className="eyebrow block" htmlFor="ask-problem">
                            把题目抄在这里
                        </label>
                        <textarea
                            id="ask-problem"
                            value={problem}
                            onChange={(e) => setProblem(e.target.value)}
                            rows={5}
                            autoFocus
                            placeholder={'例：一辆汽车 3 小时行驶 180 千米，照这样计算，5 小时行驶多少千米？'}
                            className="input-hero resize-y leading-relaxed"
                        />
                        <div className="flex flex-wrap items-center gap-3">
                            <Button size="lg" onClick={() => void submit()} disabled={!problem.trim() || submitting}>
                                {submitting ? '收题中……' : '就问这道'}
                            </Button>
                            <span className="text-xs text-ink-faint">
                                抄全一点，条件别漏；有图的部分可以用文字描述。
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {phase.kind === 'preparing' && (
                <div className="plate p-8 md:p-10 text-center space-y-4">
                    <div className="flex items-center justify-center gap-2.5 text-ink-faint text-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-beam animate-pulse" />
                        正在把这道题读懂……（解题 → 验算 → 准备讲解）
                    </div>
                    <p className="stem whitespace-pre-wrap text-left max-w-xl mx-auto">{problem}</p>
                    <p className="text-sm text-ink-soft leading-relaxed">
                        要先把答案算准并验算一遍，才敢拿来给你判卷——这一步可能要几分钟。
                    </p>
                    <p className="text-xs text-ink-faint numeric">
                        已等待 {Math.max(0, Math.round((now - phase.startedAt) / 1000))} 秒
                    </p>
                    <Button variant="ghost" onClick={askAnother}>
                        改一改题目
                    </Button>
                </div>
            )}

            {phase.kind === 'ready' && (
                <div className="space-y-3">
                    {!phase.isNew && (
                        <p className="text-xs text-ink-faint px-1">这道题之前问过，直接接着做。</p>
                    )}
                    <QuestionCard
                        key={phase.item.question.id}
                        item={phase.item}
                        index={0}
                        total={1}
                        learnerId={learner.id}
                        onDone={(record) => setPhase({ kind: 'done', record })}
                    />
                </div>
            )}

            {phase.kind === 'done' && <DonePanel record={phase.record} onAskAnother={askAnother} onBack={backToPractice} />}

            {phase.kind === 'error' && (
                <ErrorState message={phase.message} onRetry={() => void submit()} />
            )}
        </div>
    )
}

/** 收尾：说清这道题到底算不算学会了，再给两个出口。金色只在真的点亮时出现。 */
function DonePanel({
    record,
    onAskAnother,
    onBack,
}: {
    record: QuestionRecord
    onAskAnother: () => void
    onBack: () => void
}) {
    const lit = record.variantCorrect === true
    const soloCorrect = record.correct && !record.diagnosed

    let title = '这道题先放一放'
    let hint = '它已经记进错题本，过两天我们再回来找它。'
    if (lit) {
        title = '弄懂了！'
        hint = '讲解之后变式题也做对了——这才叫真的会。'
    } else if (soloCorrect) {
        title = record.hintLevel > 0 ? '做出来了！' : '自己拿下了！'
        hint =
            record.hintLevel > 0
                ? '用了提示也没关系，能顺着提示走通就是进步。'
                : '一次就对，这道题你是真的会。'
    } else if (record.review) {
        title = '已交给家长确认'
        hint = '这类题需要人来看一眼，稍后家长会确认。'
    } else if (record.variantCorrect === false) {
        title = '还差一点'
        hint = '变式题没过，说明这个坑还在——已经记进错题本，明天再来一次。'
    }

    return (
        <div className="plate p-8 text-center space-y-4">
            {lit && (
                <div className="flex justify-center">
                    <Badge tone="lit">点亮</Badge>
                </div>
            )}
            <h3 className="text-2xl font-bold text-ink tracking-tight">{title}</h3>
            <p className="text-ink-soft leading-relaxed">{hint}</p>
            <div className="flex flex-wrap justify-center gap-3 pt-1">
                <Button size="lg" onClick={onAskAnother}>
                    再问一道
                </Button>
                <Button size="lg" variant="secondary" onClick={onBack}>
                    回练习
                </Button>
            </div>
        </div>
    )
}
