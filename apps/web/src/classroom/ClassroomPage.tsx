import { useCallback, useEffect, useRef, useState } from 'react'
import { ExplainerPlayer, type SceneSpec } from '@mathtutor/explainer-web'
import {
    ClassroomSession,
    loadProgress,
    saveProgress,
    type ClassroomState,
    type ProgressStore,
} from '@mathtutor/classroom-runtime'

import { useLearner } from '../learner/LearnerContext'
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from '../ui'
import { getLesson, listLessons, submitClassroomAnswer, type ComposedLesson, type LessonOption } from './api'
import { createClassroomBridge } from './playerAdapter'

/**
 * 课堂页：一节 compose 课，从开场讲到提问、答完回到原处、最后小结。
 *
 * 三件这次专门做对的事：
 * 1. **旁白就是时钟**：每一拍停在那儿等孩子按「讲完了」，而不是自己往下走。
 *    compose 课没有 TTS，用自动计时等于替他决定"看完没看完"。
 * 2. **提问插在讲到的那一拍**：答完回到的是那一拍，不是从头再来（状态机保证）。
 * 3. **断点续学**：存的是拍号（不是秒）。关掉页面再进来，问一句要不要接着上次。
 *
 * 课堂里没有答案：题目数据来自 /classroom/lesson，那里就不下发 answer/analysis，
 * 判卷在服务端 /practice/submit 完成。
 */

/** 学科显示名：`en` 是英语学科包的 id，`english` 是图谱里节点的写法 */
const SUBJECT_LABEL: Record<string, string> = { math: '数学', en: '英语', english: '英语' }

/**
 * 按学科分组。
 *
 * 不加分组时，英语课会沉在几十个数学知识点下面——不是"排在后面"，是**翻不到**。
 * 组的先后按后端给的顺序（后端已按学段排过），这里只负责分开。
 */
function groupBySubject(options: LessonOption[]): [string, LessonOption[]][] {
    const groups = new Map<string, LessonOption[]>()
    for (const option of options) {
        const key = option.subject || 'math'
        const list = groups.get(key)
        if (list) list.push(option)
        else groups.set(key, [option])
    }
    return [...groups.entries()]
}

/** 浏览器存储：课堂运行时不认识 localStorage，这里给它一个最小的实现 */
const browserStore: ProgressStore = {    get: (key) => {
        try {
            return window.localStorage.getItem(key)
        } catch {
            return null
        }
    },
    set: (key, value) => {
        try {
            window.localStorage.setItem(key, value)
        } catch {
            /* 隐私模式下写不进去：进度存不了不该让课上不了 */
        }
    },
}

const PHASE_LABEL: Record<ClassroomState['phase'], string> = {
    idle: '还没开始',
    explaining: '正在讲',
    'awaiting-answer': '等你作答',
    feedback: '刚答完',
    summary: '小结',
    done: '下课',
}

export function ClassroomPage() {
    const { learner } = useLearner()
    const [options, setOptions] = useState<LessonOption[]>([])
    const [picked, setPicked] = useState<string | null>(null)
    const [lesson, setLesson] = useState<ComposedLesson | null>(null)
    const [state, setState] = useState<ClassroomState | null>(null)
    const [resumeFrom, setResumeFrom] = useState<number | null>(null)
    const [answer, setAnswer] = useState('')
    const [verdict, setVerdict] = useState<{ correct: boolean; answer?: string } | null>(null)
    /** 提问拍上答过的拍号：答完回到原处就不再被同一道题拦住 */
    const [pauseAnswered, setPauseAnswered] = useState<number[]>([])
    /** 连错两次后明确放弃的拍号（留痕的是"他放弃过"，不是悄悄放过） */
    const [pauseSkipped, setPauseSkipped] = useState<number[]>([])
    const [pauseTriesMap, setPauseTriesMap] = useState<Record<number, number>>({})
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    /** 讲课模式：AI 生成优先，离线组课永远可用（服务端保证退得回来） */
    const [mode, setMode] = useState<'generate' | 'compose'>('generate')

    const stageRef = useRef<HTMLDivElement | null>(null)
    const playerRef = useRef<ExplainerPlayer | null>(null)
    const sessionRef = useRef<ClassroomSession | null>(null)

    useEffect(() => {
        void (async () => {
            try {
                setOptions((await listLessons()).lessons)
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
            }
        })()
    }, [])

    /** 开一节课：拉内容、装播放器、接状态机；有进度就问一句要不要接着上次 */
    /*
     * 断点续学的键带上孩子：早先只有 nodeId，同一台平板上两个孩子上下机，
     * 后一个会从"前一个停的那一拍"开始——这就是阶段 3 DoD 里"孩子间隔离"没做到的地方。
     */
    const progressKey = useCallback(
        (nodeId: string) => (learner ? `${learner.id}:${nodeId}` : nodeId),
        [learner],
    )

    const openLesson = useCallback(async (nodeId: string) => {
        setError(null)
        setBusy(true)
        try {
            const next = await getLesson(nodeId, mode)
            setLesson(next)
            setPicked(nodeId)
            setVerdict(null)
            setAnswer('')
            // 提问拍的"答过/放弃过"跟着课重置
            setPauseAnswered([])
            setPauseSkipped([])
            setPauseTriesMap({})
            const saved = loadProgress(browserStore, progressKey(nodeId), next.scene.scenes.length)
            setResumeFrom(saved ? saved.beatIndex : null)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }, [mode, progressKey])

    const dispatch = useCallback(
        (event: Parameters<ClassroomSession['dispatch']>[0]) => {
            const session = sessionRef.current
            if (!session) return
            const next = session.dispatch(event)
            setState(next as ClassroomState)
            if (lesson) saveProgress(browserStore, progressKey(lesson.nodeId), next as ClassroomState)
        },
        [lesson, progressKey],
    )

    // 内容一到就装播放器：scene 是数据，播放器只是把它画出来
    useEffect(() => {
        const stage = stageRef.current
        if (!stage || !lesson) return
        playerRef.current?.destroy()
        /*
         * 桥要在播放器之后建（它需要那个实例），而播放器又需要桥的回调——
         * 用一个可空变量接上：回调只会在渲染时被调用，那时桥已经建好了。
         */
        let bridge: ReturnType<typeof createClassroomBridge> | null = null
        const player = new ExplainerPlayer(stage, lesson.scene as unknown as SceneSpec, {
            autoPlay: false,
            controls: false,
            // 课堂按拍走，不按秒走：转场给一点，孩子才看得见"翻页了"
            transitionMs: 240,
            // 播放器自己往前走时（将来接了 TTS），也走同一条事件：
            // 课堂的状态和画面任何时候都只有一份来源
            onBeatChange: (index, total) => bridge?.onBeatChange(index, total),
        })
        playerRef.current = player
        bridge = createClassroomBridge(player, (event) => dispatch(event))
        const session = new ClassroomSession(bridge.beatPlayer, lesson.scene.scenes.length)
        sessionRef.current = session
        setState(session.current as ClassroomState)
        return () => {
            playerRef.current?.destroy()
            playerRef.current = null
            sessionRef.current = null
        }
    }, [lesson, dispatch])

    const submit = async () => {
        if (!lesson?.question || !learner) return
        setBusy(true)
        setError(null)
        try {
            const result = await submitClassroomAnswer({
                learnerId: learner.id,
                questionId: lesson.question.questionId,
                answer,
            })
            setVerdict({ correct: result.correct, answer: result.correct ? undefined : result.correctAnswer })
            // 这一拍答过了：回到原处之后不该再被同一道题拦住
            if (state) {
                const beat = state.beatIndex
                setPauseAnswered((prev) => (prev.includes(beat) ? prev : [...prev, beat]))
                setPauseTriesMap((prev) => ({ ...prev, [beat]: (prev[beat] ?? 0) + 1 }))
            }
            dispatch({ type: 'answer', correct: result.correct })
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const narration = state && lesson ? lesson.narrations[state.beatIndex] ?? '' : ''
    /*
     * 提问拍不可跳过（宪法第 1 条：理解由行为验证）。
     *
     * 早先这一拍上"讲完了，继续"一直在：一路点下去就能下课，提问拍等于没有。
     * 现在走到这一拍只留「做一道题看看」；答过（或连错两次后明确放弃）才放行。
     */
    const atPauseBeat = lesson !== null && state?.beatIndex === lesson.pauseBeatIndex
    const pauseSettled = state ? pauseAnswered.includes(state.beatIndex) || pauseSkipped.includes(state.beatIndex) : false
    const atPause = atPauseBeat && state?.phase === 'explaining' && Boolean(lesson?.question) && !pauseSettled
    const pauseTries = state ? (pauseTriesMap[state.beatIndex] ?? 0) : 0

    return (
        <div className="space-y-6">
            <PageHeader title="课堂" subtitle="一节课：先讲、再停一下让你自己想、答完回到原处，最后小结" />

            {error && <ErrorState message={error} onRetry={() => setError(null)} />}

            <Card className="p-5 space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="flex-1 min-w-[240px]">
                        <span className="eyebrow block mb-2">这节课学什么</span>
                        <select
                            className="w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px]"
                            value={picked ?? ''}
                            onChange={(e) => void openLesson(e.target.value)}
                            disabled={busy}
                        >
                            <option value="">选一个知识点…</option>
                            {groupBySubject(options).map(([subject, list]) => (                                <optgroup key={subject} label={SUBJECT_LABEL[subject] ?? subject}>
                                    {list.map((option) => (
                                        <option key={option.nodeId} value={option.nodeId}>
                                            {option.name}（{option.questionCount} 道题可问）
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                    </label>
                    {lesson && (
                        <div className="text-xs text-ink-faint">
                            这节课有 {lesson.materialBeats} 拍是真材实料
                            {lesson.question ? '' : ' · 没有可用的题，只讲不提问'}
                        </div>
                    )}
                </div>

                {options.length === 0 && !busy && (
                    <EmptyState title="还没有能开的课" hint="先录几道题：课堂提问从题库里挑能发给孩子的题" />
                )}

                {resumeFrom !== null && (
                    <div className="flex flex-wrap items-center gap-3 text-sm text-ink-soft">
                        <span>上次学到第 {resumeFrom + 1} 拍。</span>
                        <Button
                            size="sm"
                            onClick={() => {
                                dispatch({ type: 'start' })
                                // 恢复到上次那一拍：resume 语义是"回到位置"，不是重放过程
                                for (let i = 0; i < resumeFrom; i++) dispatch({ type: 'beat-finished' })
                                setResumeFrom(null)
                            }}
                        >
                            接着学
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                                dispatch({ type: 'start' })
                                setResumeFrom(null)
                                setPauseAnswered([])
                                setPauseSkipped([])
                                setPauseTriesMap({})
                            }}
                        >
                            从头开始
                        </Button>
                    </div>
                )}
            </Card>

            {busy && !lesson && <LoadingState text="正在组课…" />}

            {lesson && (
                <Card className="p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-lg font-semibold text-ink">{lesson.nodeName}</h3>
                        <div className="flex items-center gap-2">
                            {/* 这节课是谁讲的要说清楚：模型写的和离线拼的，孩子有知情权 */}
                            <Badge tone={lesson.mode === 'generate' ? 'beam' : 'slate'}>
                                {lesson.mode === 'generate' ? 'AI 讲解' : '离线组课'}
                            </Badge>
                            <button
                                type="button"
                                onClick={() => setMode((m) => (m === 'generate' ? 'compose' : 'generate'))}
                                className="text-xs text-ink-faint hover:text-beam underline decoration-dotted underline-offset-2"
                                title="切换讲解方式，下一节生效"
                            >
                                {mode === 'generate' ? '改用离线组课' : '改用 AI 讲解'}
                            </button>
                            <Badge tone="sky">{state ? PHASE_LABEL[state.phase] : '还没开始'}</Badge>
                            <span className="text-xs text-ink-faint numeric">
                                {state ? `${state.beatIndex + 1} / ${state.beatCount}` : ''}
                            </span>
                        </div>
                    </div>

                    <div ref={stageRef} className="rounded-[10px] border border-rule bg-plate p-3 min-h-[220px]" />

                    <p className="text-sm text-ink leading-relaxed min-h-[44px]">
                        {state?.phase === 'awaiting-answer' ? '先别急着看下面的按钮，想想你会怎么做。' : narration}
                    </p>

                    <div className="flex flex-wrap items-center gap-2">
                        {state?.phase === 'idle' && (
                            <Button onClick={() => dispatch({ type: 'start' })}>开始上课</Button>
                        )}

                        {state?.phase === 'explaining' && (
                            <>
                                {/* 提问拍上不给"继续"：先做题 */}
                                {!atPause && (
                                    <Button variant="secondary" onClick={() => dispatch({ type: 'beat-finished' })}>
                                        讲完了，继续
                                    </Button>
                                )}
                                {atPause && lesson.question && (
                                    <Button onClick={() => dispatch({ type: 'pause-question', question: lesson.question!.stem })}>
                                        做一道题看看
                                    </Button>
                                )}
                                {/* 连错两次给一条说明白了的退路，但不留默认可走的门 */}
                                {atPause && pauseTries >= 2 && (
                                    <Button
                                        variant="ghost"
                                        onClick={() => {
                                            setPauseSkipped((prev) => [...prev, state.beatIndex])
                                            dispatch({ type: 'beat-finished' })
                                        }}
                                    >
                                        先往下讲，回头再练这道
                                    </Button>
                                )}
                            </>
                        )}

                        {state?.phase === 'summary' && (
                            <Button onClick={() => dispatch({ type: 'finish' })}>下课</Button>
                        )}

                        {state?.phase === 'done' && (
                            <div className="text-sm text-ink-soft">
                                {verdict
                                    ? '这节课到这里。刚才那道题已经记进你的学习记录。'
                                    : '这节课到这里。这节课没有做题，所以学习记录里没有新增。'}
                            </div>
                        )}
                    </div>

                    {state?.phase === 'awaiting-answer' && lesson.question && (
                        <div className="space-y-3 border-t border-rule pt-3">
                            <div className="text-sm text-ink">{lesson.question.stem}</div>
                            {lesson.question.options ? (
                                <div className="flex flex-wrap gap-2" data-testid="lesson-options">
                                    {lesson.question.options.map((option) => (
                                        <Button
                                            key={option}
                                            size="sm"
                                            variant={answer === option ? 'primary' : 'secondary'}
                                            onClick={() => setAnswer(option)}
                                        >
                                            {option}
                                        </Button>
                                    ))}
                                </div>
                            ) : (
                                <input
                                    className="w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px]"
                                    value={answer}
                                    onChange={(e) => setAnswer(e.target.value)}
                                    placeholder="写下你的答案"
                                />
                            )}
                            <Button onClick={() => void submit()} disabled={busy || answer.trim().length === 0}>
                                提交
                            </Button>
                        </div>
                    )}

                    {state?.phase === 'feedback' && verdict && (
                        <div className="text-sm">
                            {verdict.correct ? (
                                <span className="text-emerald-600">对了——刚才讲的用上了。</span>
                            ) : (
                                <span className="text-amber-600">
                                    还不对，再想想刚才那一拍。
                                    {verdict.answer ? ` 正确答案是 ${verdict.answer}。` : ''}
                                </span>
                            )}
                            <Button size="sm" className="ml-3" onClick={() => dispatch({ type: 'resume' })}>
                                回到刚才那一拍
                            </Button>
                        </div>
                    )}

                    {lesson.note && <div className="text-xs text-ink-faint">{lesson.note}</div>}
                </Card>
            )}
        </div>
    )
}
