/**
 * 「英语」页：词汇卡 + 分级阅读。
 *
 * 这一页有一条共同的纪律：**整页不依赖模型**。
 * 词从本地词表来，短文从本地文件来，判卷在服务端做规则比对（verification=reference）。
 * 之所以要写死在页头：英语课一旦接上模型，孩子答错时给什么、答对时夸什么就变成了
 * 每次都不一样的东西，家长没法复核，孩子也没法指望"我明明写对了"这句话有下文。
 * 本地词表 + 原文出处，是这一页唯一撑得住的地板。
 *
 * 交互上的两个小决定（都有原因，不是审美）：
 * - 词卡**一次一张**：一屏摆六张卡，孩子会挨个点完然后一张都记不住。
 * - 阅读题在**短文下面**，不盖住原文：答案在原文里，原文看不见就成了背答案。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useLearner } from '../learner/LearnerContext'
import { LearnerGate, LearnerSwitcher } from '../practice/LearnerGate'
import { Badge, Button, EmptyState, ErrorState, Lightline, LoadingState, PageHeader } from '../ui'
import {
    fetchPassage,
    fetchReadingList,
    fetchVocabToday,
    postReadingAnswer,
    postVocabAnswer,
    type Passage,
    type ReadingList,
    type VocabToday,
} from './api'
import {
    activeQuestionIndex,
    buildVocabQueue,
    createVocabSession,
    currentVocabTask,
    explainEnglishFailure,
    isModuleBlocked,
    markEvidence,
    masteredRatio,
    passageDone,
    passageMeta,
    passageStatus,
    vocabFace,
    vocabFinished,
    vocabReducer,
    type ReadingAnswer,
    type VocabSession,
} from './logic'

type Tab = 'vocab' | 'reading'

/** 今日词卡的加载状态：403（家长关掉）要单独站出来，它不是一个错误 */
type TodayState =
    | { status: 'loading' }
    | { status: 'ready'; today: VocabToday }
    | { status: 'blocked'; message: string }
    | { status: 'error'; message: string }

export function EnglishPage() {
    const { learner } = useLearner()
    const learnerId = learner?.id
    const [tab, setTab] = useState<Tab>('vocab')
    const [today, setToday] = useState<TodayState>({ status: 'loading' })

    const loadToday = useCallback(async () => {
        if (!learnerId) {
            setToday({ status: 'loading' })
            return
        }
        setToday({ status: 'loading' })
        try {
            setToday({ status: 'ready', today: await fetchVocabToday(learnerId) })
        } catch (err) {
            /* 403 不是故障，是家长的决定：整页拦住，别让孩子在两个 tab 里白点 */
            setToday(
                isModuleBlocked(err)
                    ? { status: 'blocked', message: explainEnglishFailure(err) }
                    : { status: 'error', message: explainEnglishFailure(err) },
            )
        }
    }, [learnerId])

    useEffect(() => {
        void loadToday()
    }, [loadToday])

    if (!learner || !learnerId) return <LearnerGate />

    return (
        <div className="space-y-4">
            <PageHeader
                title="英语"
                subtitle="先复习到期的词，再学几个新词；读完短文再回答三道题"
            />
            <LearnerSwitcher />

            {today.status === 'blocked' ? (
                /*
                 * 英语模块只有一个总开关，词汇接口是它的守门人。
                 * 所以在这里整页拦住，而不是只挡「词汇」这一个 tab——
                 * 家长关掉的是"英语"，不是一个按钮。
                 */
                <div className="plate p-8 max-w-lg mx-auto text-center space-y-2">
                    <h3 className="text-lg font-semibold text-ink">今天先不练英语</h3>
                    <p className="text-sm text-ink-soft leading-relaxed">{today.message}</p>
                    <p className="text-xs text-ink-faint">
                        开关在「家长」页的模块开关里，家长随时可以打开。
                    </p>
                </div>
            ) : (
                <>
                    <div className="flex items-center gap-1 rounded-[10px] border border-rule bg-paper p-1 w-fit">
                        {(
                            [
                                ['vocab', '词汇'],
                                ['reading', '阅读'],
                            ] as const
                        ).map(([key, label]) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setTab(key)}
                                className={`px-4 py-1.5 rounded-[8px] text-sm font-medium transition-colors ${
                                    tab === key
                                        ? 'bg-beam text-white'
                                        : 'text-ink-faint hover:text-ink'
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    {tab === 'vocab' && (
                        <>
                            {today.status === 'loading' && <LoadingState text="正在取今天的词卡" />}
                            {today.status === 'error' && (
                                <ErrorState
                                    message={today.message}
                                    onRetry={() => void loadToday()}
                                />
                            )}
                            {today.status === 'ready' && (
                                <VocabTab
                                    learnerId={learnerId}
                                    today={today.today}
                                    onReload={() => void loadToday()}
                                    onGoReading={() => setTab('reading')}
                                />
                            )}
                        </>
                    )}

                    {tab === 'reading' && <ReadingTab learnerId={learnerId} />}
                </>
            )}
        </div>
    )
}

/* ────────────────────────── 词汇 tab ────────────────────────── */

function VocabTab({
    learnerId,
    today,
    onReload,
    onGoReading,
}: {
    learnerId: string
    today: VocabToday
    onReload: () => void
    onGoReading: () => void
}) {
    const queue = useMemo(() => buildVocabQueue(today), [today])
    const [session, setSession] = useState<VocabSession>(() => createVocabSession(queue))
    const [answer, setAnswer] = useState('')
    const [feedback, setFeedback] = useState<{
        correct: boolean
        reference: string
        example?: string
    } | null>(null)
    const [submitting, setSubmitting] = useState(false)
    /**
     * 这张卡是不是"看过答案之后再写一次"。
     *
     * 重写这一次的"对"不是提取出来的，所以上报时要标 retry=True，
     * 让服务端**不要**拿它推进 SM-2——不然等于用开卷考试的成绩决定什么时候复习。
     */
    const [retryingCard, setRetryingCard] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement | null>(null)

    // 词卡数据换了一批（重进页面 / 换了孩子）→ 队列重来，别把上一轮的位置带过来
    useEffect(() => {
        setSession(createVocabSession(queue))
        setAnswer('')
        setFeedback(null)
        setError(null)
    }, [queue])

    const task = currentVocabTask(session)
    const face = task ? vocabFace(task) : null

    // 每次换卡、或答错后要"再记一次"，光标都回到输入框：键盘不该被手指找
    useEffect(() => {
        if (session.verdict === null) inputRef.current?.focus()
    }, [session.index, session.verdict])

    const submit = async () => {
        const trimmed = answer.trim()
        if (!task || !trimmed || submitting || session.verdict !== null) return
        setSubmitting(true)
        setError(null)
        try {
            const res = await postVocabAnswer({
                learnerId,
                wordId: task.card.id,
                answer: trimmed,
                direction: task.direction,
                ...(retryingCard ? { retry: true } : {}),
            })
            setSession((s) => vocabReducer(s, { type: 'answered', correct: res.correct }))
            setFeedback({ correct: res.correct, reference: res.reference, example: res.example })
        } catch (err) {
            setError(explainEnglishFailure(err))
        } finally {
            setSubmitting(false)
        }
    }

    const next = () => {
        setSession((s) => vocabReducer(s, { type: 'next' }))
        setAnswer('')
        setFeedback(null)
        setError(null)
        setRetryingCard(false)
    }

    const retry = () => {
        setRetryingCard(true)
        setSession((s) => vocabReducer(s, { type: 'retry' }))
        setAnswer('')
        setFeedback(null)
        setError(null)
    }

    const { stats } = today

    return (
        <div className="space-y-4">
            {/* 顶部进度：今天要复习几张、已学会多少 / 共多少 */}
            <div className="plate p-5 space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <p className="eyebrow">今天要复习</p>
                        <p className="text-2xl font-bold text-ink numeric">{stats.dueToday} 张</p>
                    </div>
                    <div className="text-right">
                        <p className="eyebrow">已学会</p>
                        <p className="text-2xl font-bold text-ink numeric">
                            {stats.mastered}
                            <span className="text-base text-ink-faint font-medium"> / {stats.total}</span>
                        </p>
                    </div>
                </div>
                <Lightline value={masteredRatio(stats)} max={1} />
                {/* 服务端给的那句话：先说复习再学新词，孩子才知道这轮为什么从旧词开始 */}
                <p className="text-sm text-ink-soft leading-relaxed">{today.note}</p>
            </div>

            {/* 收尾状态：队列空了或做完了都给一块交代，绝不留一个空白输入框 */}
            {vocabFinished(session) && (
                <div className="plate p-8 text-center space-y-3">
                    <h3 className="text-section">
                        {session.queue.length === 0 ? '今天没有要练的词' : '今天的词都练完了'}
                    </h3>
                    {session.queue.length > 0 && (
                        <p className="text-sm text-ink-soft">
                            这一轮答对了{' '}
                            <span className="numeric font-semibold text-ink">{session.correct}</span>
                            <span className="numeric text-ink-faint"> / {session.queue.length}</span> 张。
                            明天这些词会再来一遍——再认出来一次，才算真的记住。
                        </p>
                    )}
                    {session.queue.length === 0 && (
                        /* 没词可练时，上面那块统计说的也是同一句话，这里再说一次是为了不让人以为页面坏了 */
                        <p className="text-xs text-ink-faint">{today.note}</p>
                    )}
                    <div className="flex flex-wrap justify-center gap-2 pt-2">
                        <Button variant="secondary" onClick={onReload}>
                            看一眼今天的词
                        </Button>
                        <Button onClick={onGoReading}>去读一篇短文 →</Button>
                    </div>
                </div>
            )}

            {task && face && (
                <div className="plate p-6 md:p-8 space-y-5">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-ink-faint">
                            第{' '}
                            <span className="numeric text-base font-semibold text-beam">
                                {session.index + 1}
                            </span>
                            <span className="numeric"> / {session.queue.length}</span> 张
                        </span>
                        <Badge tone={task.kind === 'review' ? 'beam' : 'slate'}>
                            {task.kind === 'review' ? '复习' : '新词'}
                        </Badge>
                    </div>

                    <p className="eyebrow">{face.ask}</p>
                    <p
                        className={`font-bold text-ink tracking-tight break-words ${
                            face.script === 'han' ? 'text-3xl md:text-4xl' : 'text-4xl md:text-5xl'
                        }`}
                    >
                        {face.prompt}
                    </p>

                    <input
                        ref={inputRef}
                        type="text"
                        value={answer}
                        disabled={session.verdict !== null}
                        onChange={(e) => setAnswer(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault()
                                void submit()
                            }
                        }}
                        placeholder={face.placeholder}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        className="input-hero disabled:bg-paper disabled:text-ink-faint"
                    />

                    {/* 答对：绿色。词和例句一起给——例句是这个词第一次"能用的样子" */}
                    {feedback?.correct && (
                        <div className="rounded-[10px] bg-correct-wash border border-correct/25 px-4 py-3 space-y-1.5">
                            <p className="font-semibold text-[var(--color-correct)]">记住了</p>
                            <p className="text-ink">
                                <span className="font-semibold">{task.card.en}</span>
                                <span className="text-ink-faint"> · </span>
                                <span>{task.card.zh}</span>
                                <span className="ml-2 align-middle">
                                    <Badge tone="slate">{task.card.cefr}</Badge>
                                </span>
                            </p>
                            <ExampleLine example={task.card.example} />
                        </div>
                    )}

                    {/*
                      答错：红色给出参考答案 + 例句。
                      为什么答错反而要例句：错的从来不是"不知道中文意思"，
                      而是这个词在句子里怎么用；光给一个对照词，抄一遍就过去了。
                    */}
                    {feedback && !feedback.correct && (
                        <div className="rounded-[10px] bg-wrong-wash border border-wrong/25 px-4 py-3 space-y-1.5">
                            <p className="font-semibold text-wrong">还差一点，正确的写法是：</p>
                            <p className="text-ink">
                                <span className="font-semibold">{feedback.reference}</span>
                                <span className="text-ink-faint">
                                    {' '}
                                    （{task.card.en} · {task.card.zh}）
                                </span>
                            </p>
                            {/* 服务端只在答错时回传 example；取不到就用今日词表里同一张卡的例句 */}
                            <ExampleLine example={feedback.example ?? task.card.example} />
                        </div>
                    )}

                    {error && (
                        <div className="rounded-[10px] bg-wrong-wash border border-wrong/25 px-4 py-3 text-wrong text-sm">
                            {error}
                        </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                        {session.verdict === null && (
                            <Button
                                size="lg"
                                onClick={() => void submit()}
                                disabled={!answer.trim() || submitting}
                            >
                                {submitting ? '正在核对…' : '交卷'}
                            </Button>
                        )}
                        {session.verdict === 'wrong' && (
                            <>
                                <Button size="lg" onClick={retry}>
                                    再记一次
                                </Button>
                                <Button size="lg" variant="secondary" onClick={next}>
                                    下一个
                                </Button>
                            </>
                        )}
                        {session.verdict === 'correct' && (
                            <Button size="lg" onClick={next}>
                                下一个
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

function ExampleLine({ example }: { example?: string }) {
    if (!example) return null
    return (
        <p className="text-sm text-ink-soft leading-relaxed">
            <span className="eyebrow mr-2">例句</span>
            {example}
        </p>
    )
}

/* ────────────────────────── 阅读 tab ────────────────────────── */

function ReadingTab({ learnerId }: { learnerId: string }) {
    const [list, setList] = useState<ReadingList | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [openId, setOpenId] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            setList(await fetchReadingList(learnerId))
        } catch (err) {
            setError(explainEnglishFailure(err))
        } finally {
            setLoading(false)
        }
    }, [learnerId])

    useEffect(() => {
        void load()
    }, [load])

    // 进一篇短文。回来时重拉列表：刚答的题要出现在完成度里
    if (openId) {
        return (
            <PassageView
                learnerId={learnerId}
                passageId={openId}
                onBack={() => {
                    setOpenId(null)
                    void load()
                }}
            />
        )
    }

    return (
        <div className="space-y-3">
            {loading && <LoadingState text="正在打开短文列表" />}
            {error && <ErrorState message={error} onRetry={() => void load()} />}
            {list && list.passages.length === 0 && (
                <EmptyState
                    title="还没有短文"
                    hint="短文还没放进内容目录，等家长加一篇就能读了。"
                />
            )}

            {list?.passages.map((passage) => (
                <button
                    key={passage.id}
                    type="button"
                    onClick={() => setOpenId(passage.id)}
                    className="plate w-full text-left p-5 space-y-1.5 hover:border-beam transition-colors"
                >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-ink">{passage.title}</span>
                        {passage.done ? (
                            <Badge tone="correct">读完了</Badge>
                        ) : (
                            <span className="text-xs text-ink-faint">{passageStatus(passage)}</span>
                        )}
                    </div>
                    <p className="text-xs text-ink-faint numeric">{passageMeta(passage)}</p>
                </button>
            ))}

            {/* 被丢掉的题如实交代：没有原文依据的题，判对了也说不清为什么对 */}
            {list && list.dropped.length > 0 && (
                <p className="text-xs text-ink-faint px-1 leading-relaxed">
                    有 {list.dropped.length} 道题没放进来：它们的答案在短文里找不到出处。
                    没有出处的题，判对了也没法回头核对。
                </p>
            )}
        </div>
    )
}

/** 一篇短文 + 三道题：短文在上面，题目在下面，逐题作答 */
function PassageView({
    learnerId,
    passageId,
    onBack,
}: {
    learnerId: string
    passageId: string
    onBack: () => void
}) {
    const [passage, setPassage] = useState<Passage | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [answers, setAnswers] = useState<Record<string, ReadingAnswer>>({})
    const [input, setInput] = useState('')
    const [submitting, setSubmitting] = useState(false)
    const [submitError, setSubmitError] = useState<string | null>(null)
    /**
     * 刚答对的那道题：保留在屏幕上，让孩子先看清原文依据再往下走。
     * 答对就立刻换下一题的话，那句依据一闪而过，等于没讲。
     */
    const [revealed, setRevealed] = useState<{ questionId: string } | null>(null)
    const inputRef = useRef<HTMLInputElement | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            setPassage(await fetchPassage(passageId))
        } catch (err) {
            setError(explainEnglishFailure(err))
        } finally {
            setLoading(false)
        }
    }, [passageId])

    useEffect(() => {
        void load()
    }, [load])

    const questions = useMemo(() => passage?.questions ?? [], [passage])
    const done = passage ? passageDone(questions, answers) : false
    const activeIndex = activeQuestionIndex(questions, answers)
    const shownIndex = revealed
        ? questions.findIndex((q) => q.id === revealed.questionId)
        : activeIndex
    const question = shownIndex >= 0 ? questions[shownIndex] : null
    /** 已经亮出来的原文依据（答对才进 answers，所以这里天然只有"该给的那些"） */
    const evidences = useMemo(
        () =>
            Object.values(answers).flatMap((a) =>
                a.status === 'correct' ? [a.evidence] : [],
            ),
        [answers],
    )
    const correctCount = Object.values(answers).filter((a) => a.status === 'correct').length

    const currentAnswer = question ? answers[question.id] : undefined

    useEffect(() => {
        if (question && currentAnswer?.status !== 'correct') inputRef.current?.focus()
    }, [question, currentAnswer?.status])

    const submit = async () => {
        const trimmed = input.trim()
        if (!question || !trimmed || submitting || currentAnswer?.status === 'correct') return
        setSubmitting(true)
        setSubmitError(null)
        try {
            const res = await postReadingAnswer({
                learnerId,
                passageId,
                questionId: question.id,
                answer: trimmed,
            })
            if (res.correct) {
                setAnswers((prev) => ({
                    ...prev,
                    [question.id]: { status: 'correct', reference: res.reference, evidence: res.evidence },
                }))
                setRevealed({ questionId: question.id })
                setInput('')
            } else {
                setAnswers((prev) => ({
                    ...prev,
                    [question.id]: { status: 'wrong', hint: res.hint },
                }))
            }
        } catch (err) {
            setSubmitError(explainEnglishFailure(err))
        } finally {
            setSubmitting(false)
        }
    }

    const advance = () => {
        setRevealed(null)
        setInput('')
        setSubmitError(null)
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <Button size="sm" variant="secondary" onClick={onBack}>
                    ← 返回短文列表
                </Button>
                {passage && (
                    <span className="text-xs text-ink-faint numeric">
                        {passage.level} · 已答对 {correctCount} / {questions.length}
                    </span>
                )}
            </div>

            {loading && <LoadingState text="正在打开这篇短文" />}
            {error && <ErrorState message={error} onRetry={() => void load()} />}

            {passage && (
                <>
                    {/* 短文：整段摊开，题在下面——原文被盖住，阅读就变成了背答案 */}
                    <div className="plate p-6 space-y-2">
                        <h3 className="text-section">{passage.title}</h3>
                        <p className="text-lg leading-loose text-ink">
                            {markEvidence(passage.text, evidences).map((part, i) =>
                                part.hit ? (
                                    <mark
                                        key={i}
                                        className="bg-lit-wash text-ink rounded-[3px] px-0.5"
                                    >
                                        {part.text}
                                    </mark>
                                ) : (
                                    <span key={i}>{part.text}</span>
                                ),
                            )}
                        </p>
                    </div>

                    {done && !revealed ? (
                        <div className="plate p-8 text-center space-y-3">
                            <h3 className="text-section">读完了</h3>
                            <p className="text-sm text-ink-soft">
                                《{passage.title}》的三道题都答对了。
                                上面标黄的那些句子，就是答案所在的地方。
                            </p>
                            <div className="flex justify-center pt-1">
                                <Button onClick={onBack}>回短文列表挑下一篇</Button>
                            </div>
                        </div>
                    ) : question ? (
                        <div className="plate p-6 space-y-4">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm text-ink-faint">
                                    第{' '}
                                    <span className="numeric text-base font-semibold text-beam">
                                        {shownIndex + 1}
                                    </span>
                                    <span className="numeric"> / {questions.length}</span> 题
                                </span>
                                {currentAnswer?.status === 'correct' && (
                                    <Badge tone="correct">答对了</Badge>
                                )}
                            </div>

                            <p className="text-lg text-ink leading-relaxed">{question.prompt}</p>

                            <input
                                ref={inputRef}
                                type="text"
                                value={input}
                                disabled={submitting || currentAnswer?.status === 'correct'}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault()
                                        void submit()
                                    }
                                }}
                                placeholder={
                                    currentAnswer?.status === 'wrong'
                                        ? '再读一遍短文，把答案改一改'
                                        : '用英语写下答案，按回车提交'
                                }
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                spellCheck={false}
                                className="input-hero disabled:bg-paper disabled:text-ink-faint"
                            />

                            {/* 答错只给一句话的提示，不给原文——亮原文等于把答案念出来 */}
                            {currentAnswer?.status === 'wrong' && (
                                <div className="rounded-[10px] bg-paper border border-rule px-4 py-3">
                                    <p className="eyebrow mb-1">提示</p>
                                    <p className="text-ink-soft leading-relaxed">
                                        {currentAnswer.hint}
                                    </p>
                                </div>
                            )}

                            {/*
                              答对之后才给原文依据。这一步不是奖励，是讲解：
                              让孩子看见"我凭感觉找到的答案，原来就在这一句里"。
                              答错时给原文，孩子就没有自己找的过程了。
                            */}
                            {currentAnswer?.status === 'correct' && (
                                <div className="rounded-[10px] bg-correct-wash border border-correct/25 px-4 py-3 space-y-1.5">
                                    <p className="font-semibold text-[var(--color-correct)]">
                                        答对了，答案就在这句里
                                    </p>
                                    <p className="text-ink leading-relaxed">
                                        “{currentAnswer.evidence}”
                                    </p>
                                    <p className="text-xs text-ink-faint">
                                        参考答案：{currentAnswer.reference}
                                    </p>
                                </div>
                            )}

                            {submitError && (
                                <div className="rounded-[10px] bg-wrong-wash border border-wrong/25 px-4 py-3 text-wrong text-sm">
                                    {submitError}
                                </div>
                            )}

                            <div className="flex flex-wrap gap-2">
                                {currentAnswer?.status !== 'correct' && (
                                    <Button
                                        onClick={() => void submit()}
                                        disabled={!input.trim() || submitting}
                                    >
                                        {submitting
                                            ? '正在核对…'
                                            : currentAnswer?.status === 'wrong'
                                              ? '再交一次'
                                              : '交卷'}
                                    </Button>
                                )}
                                {currentAnswer?.status === 'correct' && (
                                    <Button onClick={advance}>
                                        {activeIndex === -1 ? '读完了' : '下一题'}
                                    </Button>
                                )}
                            </div>
                        </div>
                    ) : null}
                </>
            )}
        </div>
    )
}
