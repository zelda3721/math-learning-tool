/**
 * P1a 做题页：选人 → 今日题组 → 逐题作答（判卷 + 提示阶梯）→ 完成小结。
 * fetch 直连 server API，状态机全部收在本组件；子组件见同目录。
 */
import { useEffect, useState } from 'react'
import { useLearner } from '../learner/LearnerContext'
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
            <LearnerSwitcher disabled={inSession} />

            {phase.kind === 'idle' && (
                <div className="soft-glass p-10 max-w-lg mx-auto text-center space-y-5">
                    <h2 className="text-2xl font-bold text-slate-700">
                        {learner.name}，准备好了吗?
                    </h2>
                    <p className="text-slate-500">
                        每天一小组题，把知识星图一颗颗点亮。
                    </p>
                    {nextStep && (
                        <div className="rounded-2xl bg-sky-50/80 border border-sky-100 px-4 py-3 flex items-start gap-3 text-left">
                            <span className="text-2xl leading-none mt-0.5">
                                {NEXT_STEP_ICON[nextStep.kind]}
                            </span>
                            <div>
                                <p className="text-xs font-bold text-sky-400 mb-0.5">下一步</p>
                                <p className="text-slate-600 font-medium leading-relaxed">
                                    {nextStep.nextStep}
                                </p>
                            </div>
                        </div>
                    )}
                    {litCount !== null && litCount > 0 && (
                        <p className="text-sm text-slate-400">
                            ⭐ 已点亮 <span className="font-bold text-amber-500">{litCount}</span> 颗星星
                        </p>
                    )}
                    <button
                        type="button"
                        onClick={() => void startSession()}
                        className="px-10 py-4 rounded-2xl bg-sky-500 text-white text-xl font-bold shadow-lg shadow-sky-200 hover:bg-sky-600 transition-colors"
                    >
                        开始今日练习
                    </button>
                </div>
            )}

            {phase.kind === 'loading' && (
                <div className="text-center text-slate-400 py-16">正在为你挑选今天的题目……</div>
            )}

            {phase.kind === 'empty' && (
                <div className="soft-glass p-10 max-w-lg mx-auto text-center space-y-4">
                    <h2 className="text-xl font-bold text-slate-700">题库还没有题</h2>
                    <p className="text-slate-500">
                        请家长先到上方的「录题」页上传讲义或题目，再回来开始练习。
                    </p>
                    <button
                        type="button"
                        onClick={() => setPhase({ kind: 'idle' })}
                        className="px-6 py-2.5 rounded-2xl bg-white border-2 border-slate-100 text-slate-600 font-semibold hover:border-sky-300 transition-colors"
                    >
                        返回
                    </button>
                </div>
            )}

            {phase.kind === 'error' && (
                <div className="soft-glass p-10 max-w-lg mx-auto text-center space-y-4">
                    <h2 className="text-xl font-bold text-red-500">出了点小问题</h2>
                    <p className="text-slate-500">{phase.message}</p>
                    <button
                        type="button"
                        onClick={() => void startSession()}
                        className="px-8 py-3 rounded-2xl bg-sky-500 text-white font-bold shadow-lg shadow-sky-200 hover:bg-sky-600 transition-colors"
                    >
                        重试
                    </button>
                </div>
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
