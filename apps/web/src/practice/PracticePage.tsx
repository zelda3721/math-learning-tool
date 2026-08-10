/**
 * P1a 做题页：选人 → 今日题组 → 逐题作答（判卷 + 提示阶梯）→ 完成小结。
 * fetch 直连 server API，状态机全部收在本组件；子组件见同目录。
 */
import { useEffect, useState } from 'react'
import { useLearner } from '../learner/LearnerContext'
import { Badge, Button, EmptyState, ErrorState, LoadingState, PageHeader } from '../ui'
import { fetchLitCount, fetchNextStep, fetchToday, type NextStep, type TodayItem } from './api'
import { LearnerGate, LearnerSwitcher } from './LearnerGate'
import { QuestionCard, type QuestionRecord } from './QuestionCard'
import { SessionSummary } from './SessionSummary'

type Phase =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'empty' }
    | { kind: 'error'; message: string }
    | { kind: 'session'; items: TodayItem[]; index: number; records: QuestionRecord[] }
    | { kind: 'summary'; records: QuestionRecord[] }

/** 下一步建议的类型图标：复习 / 弱点 / 新题 */
const NEXT_STEP_ICON: Record<NextStep['kind'], string> = {
    review: '🔁',
    weak: '🎯',
    new: '✨',
}

export function PracticePage() {
    const { learner } = useLearner()
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
    const [nextStep, setNextStep] = useState<NextStep | null>(null)
    const [litCount, setLitCount] = useState<number | null>(null)

    // 换人后回到起点，避免题组串档
    useEffect(() => {
        setPhase({ kind: 'idle' })
    }, [learner?.id])

    // idle 态拉「下一步」建议 + 已点亮统计（都是 best-effort，失败不显示）
    const learnerId = learner?.id
    const idle = phase.kind === 'idle'
    useEffect(() => {
        if (!learnerId || !idle) return
        let cancelled = false
        setNextStep(null)
        setLitCount(null)
        void fetchNextStep(learnerId).then((r) => {
            if (!cancelled) setNextStep(r)
        })
        void fetchLitCount(learnerId).then((r) => {
            if (!cancelled) setLitCount(r)
        })
        return () => {
            cancelled = true
        }
    }, [learnerId, idle])

    if (!learner) return <LearnerGate />

    const startSession = async () => {
        setPhase({ kind: 'loading' })
        try {
            const { items } = await fetchToday(learner.id)
            if (items.length === 0) {
                setPhase({ kind: 'empty' })
            } else {
                setPhase({ kind: 'session', items, index: 0, records: [] })
            }
        } catch (err) {
            setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        }
    }

    const handleQuestionDone = (record: QuestionRecord) => {
        setPhase((prev) => {
            if (prev.kind !== 'session') return prev
            const records = [...prev.records, record]
            if (prev.index + 1 >= prev.items.length) {
                return { kind: 'summary', records }
            }
            return { ...prev, index: prev.index + 1, records }
        })
    }

    const inSession = phase.kind === 'session'

    return (
        <div className="space-y-2">
            <PageHeader title="今日练习" subtitle="每天一小组，把星图一颗颗点亮" />
            <LearnerSwitcher disabled={inSession} />

            {phase.kind === 'idle' && (
                <div className="plate p-10 max-w-lg mx-auto text-center space-y-5">
                    <h2 className="text-2xl font-bold text-ink tracking-tight">
                        {learner.name}，准备好了吗?
                    </h2>
                    <p className="text-ink-soft">
                        每天一小组题，把知识星图一颗颗点亮。
                    </p>
                    {nextStep && (
                        <div className="rounded-[10px] bg-beam-wash border border-beam/20 px-4 py-3 flex items-start gap-3 text-left">
                            <span className="text-2xl leading-none mt-0.5">
                                {NEXT_STEP_ICON[nextStep.kind]}
                            </span>
                            <div>
                                <p className="eyebrow mb-1">下一步</p>
                                <p className="text-ink font-medium leading-relaxed">
                                    {nextStep.nextStep}
                                </p>
                            </div>
                        </div>
                    )}
                    {litCount !== null && litCount > 0 && (
                        <div className="flex justify-center">
                            <Badge tone="lit">
                                已点亮 <span className="numeric mx-1 text-sm">{litCount}</span> 颗星
                            </Badge>
                        </div>
                    )}
                    <Button size="lg" onClick={() => void startSession()}>
                        开始今日练习
                    </Button>
                </div>
            )}

            {phase.kind === 'loading' && <LoadingState text="正在为你挑选今天的题目……" />}

            {phase.kind === 'empty' && (
                <EmptyState
                    title="题库还没有题"
                    hint="请家长先到上方的「录题」页上传讲义或题目，再回来开始练习。"
                    action={
                        <Button variant="secondary" onClick={() => setPhase({ kind: 'idle' })}>
                            返回
                        </Button>
                    }
                />
            )}

            {phase.kind === 'error' && (
                <ErrorState message={phase.message} onRetry={() => void startSession()} />
            )}

            {phase.kind === 'session' && (
                <QuestionCard
                    key={phase.items[phase.index]!.question.id}
                    item={phase.items[phase.index]!}
                    index={phase.index}
                    total={phase.items.length}
                    learnerId={learner.id}
                    onDone={handleQuestionDone}
                />
            )}

            {phase.kind === 'summary' && (
                <SessionSummary
                    records={phase.records}
                    learnerId={learner.id}
                    onRestart={() => void startSession()}
                />
            )}
        </div>
    )
}
