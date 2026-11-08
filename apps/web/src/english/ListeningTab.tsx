import { useCallback, useEffect, useRef, useState } from 'react'

import { Button, ErrorState, LoadingState } from '../ui'
import {
    TIMEOUTS,
    listeningDone,
    listeningVerdict,
    nextListeningIndex,
    requestJson,
    type ListeningAnswerResponse,
    type ListeningVerdict,
} from './uiLogic'

/**
 * 英语听力：听短文，答理解题。
 *
 * 关键的一条：**短文本身不下发**。这一页拿到的只有音频和题面，
 * 原文要等答完才以「原文依据」的形式出现——那是讲解，不是考卷。
 *
 * 没听清可以重听，不限次数：听力考的是听懂，不是记性。
 * 答错了也只说"再听一遍"、可以重答——第三次还错，服务端才给参考答案。
 */

interface PassageSummary {
    id: string
    title: string
    level: string
    questionCount: number
    cached: boolean
}

interface PassageAudio {
    id: string
    title: string
    level: string
    audio: string | null
    ttsAvailable: boolean
    note: string
    questions: { id: string; prompt: string }[]
}

export function ListeningTab({ learnerId }: { learnerId: string }) {
    const [list, setList] = useState<PassageSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [opened, setOpened] = useState<PassageAudio | null>(null)
    /** 正在打开的那一篇：首次要合成整篇语音，十几秒是常事，得让孩子知道在干什么 */
    const [opening, setOpening] = useState<string | null>(null)
    const [openError, setOpenError] = useState<{ id: string; message: string } | null>(null)
    const [busy, setBusy] = useState(false)
    const [index, setIndex] = useState(0)
    const [answer, setAnswer] = useState('')
    const [result, setResult] = useState<ListeningVerdict | null>(null)
    const [answerError, setAnswerError] = useState<string | null>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)
    /** 卸载 / 换一篇时掐掉还在路上的请求：结果回来时人已经不在这一页了 */
    const lifeRef = useRef<AbortController | null>(null)

    useEffect(() => {
        const life = new AbortController()
        lifeRef.current = life
        return () => {
            life.abort()
            audioRef.current?.pause()
        }
    }, [])

    const load = useCallback(async () => {
        setError(null)
        const r = await requestJson<{ passages: PassageSummary[] }>(
            `/api/v1/en/listening/list?learnerId=${encodeURIComponent(learnerId)}`,
            {},
            { timeoutMs: TIMEOUTS.list, timeoutMessage: '听力列表取得太久了，再试一次', signal: lifeRef.current?.signal },
        )
        if (r.ok) setList(r.data.passages)
        else if (!r.aborted) setError(r.error)
    }, [learnerId])

    useEffect(() => {
        setList(null)
        setOpened(null)
        void load()
    }, [load])

    const play = useCallback((base64: string | null) => {
        if (!base64) return
        try {
            const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
            const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
            audioRef.current?.pause()
            const audio = new Audio(url)
            audioRef.current = audio
            audio.onended = () => URL.revokeObjectURL(url)
            void audio.play().catch(() => {
                /* 自动播放可能被拦：界面上有「再听一遍」 */
            })
        } catch {
            /* 音频坏了不该挡住答题 */
        }
    }, [])

    const open = async (id: string) => {
        if (opening) return
        setOpening(id)
        setOpenError(null)
        setResult(null)
        setAnswerError(null)
        setIndex(0)
        setAnswer('')
        const r = await requestJson<PassageAudio>(
            `/api/v1/en/listening/passage/${encodeURIComponent(id)}?learnerId=${encodeURIComponent(learnerId)}`,
            {},
            {
                timeoutMs: TIMEOUTS.listeningOpen,
                timeoutMessage: '语音合成这次太久了（超过一分钟），本机可能正忙——再点一次试试。',
                signal: lifeRef.current?.signal,
            },
        )
        setOpening(null)
        if (r.ok) {
            setOpened(r.data)
            play(r.data.audio)
        } else if (!r.aborted) {
            setOpenError({ id, message: r.error })
        }
    }

    const submit = async () => {
        if (!opened || !answer.trim() || busy) return
        const q = opened.questions[index]
        if (!q) return
        setBusy(true)
        setAnswerError(null)
        const r = await requestJson<ListeningAnswerResponse>(
            '/api/v1/en/listening/answer',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, passageId: opened.id, questionId: q.id, answer: answer.trim() }),
            },
            { timeoutMs: TIMEOUTS.listeningAnswer, timeoutMessage: '判卷太久了，再交一次试试。', signal: lifeRef.current?.signal },
        )
        setBusy(false)
        if (!r.ok) {
            // 判卷失败只在这一题下面说一句，不把整页换成错误页——听过的不该白听
            if (!r.aborted) setAnswerError(r.error)
            return
        }
        setResult(listeningVerdict(r.data))
    }

    const next = () => {
        if (!opened) return
        setResult(null)
        setAnswer('')
        setAnswerError(null)
        // 最后一题后题号也要 +1：到 total 才是完成态，原地不动会把同一题再出一遍
        setIndex(nextListeningIndex(index, opened.questions.length))
    }

    if (error) return <ErrorState message={`听力加载失败：${error}`} onRetry={() => void load()} />
    if (!list) return <LoadingState text="正在取听力材料……" />

    if (opened) {
        const done = listeningDone(index, opened.questions.length)
        const q = opened.questions[index]
        /** 答错还能再答时：不锁输入框，只提示再听一遍 */
        const settled = result !== null && result.kind !== 'retry'
        return (
            <div className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                        <p className="font-semibold text-ink">{opened.title}</p>
                        <p className="text-xs text-ink-faint">{opened.level} · 先听两遍再答题</p>
                    </div>
                    <div className="flex gap-2">
                        <Button size="sm" variant="secondary" disabled={!opened.ttsAvailable} onClick={() => play(opened.audio)}>
                            再听一遍
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                audioRef.current?.pause()
                                setOpened(null)
                            }}
                        >
                            换一篇
                        </Button>
                    </div>
                </div>

                {!opened.ttsAvailable && (
                    <p className="rounded-[10px] border border-rule bg-paper px-3 py-2 text-sm text-ink-faint">
                        {opened.note}
                    </p>
                )}

                {done || !q ? (
                    <div className="plate p-5 space-y-2">
                        <p className="text-sm text-[color:var(--color-correct)]">这一篇的题都做完了。</p>
                        <Button size="sm" variant="secondary" onClick={() => setOpened(null)}>
                            换一篇听
                        </Button>
                    </div>
                ) : (
                    <div className="plate p-5 space-y-3">
                        <p className="text-xs text-ink-faint numeric">
                            第 {index + 1} / {opened.questions.length} 题
                        </p>
                        <p className="text-sm text-ink">{q.prompt}</p>
                        <input
                            value={answer}
                            onChange={(e) => setAnswer(e.target.value)}
                            placeholder="用英语写下你听到的答案"
                            disabled={settled}
                            className="w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px]"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !settled) void submit()
                            }}
                        />
                        {result?.kind === 'retry' && (
                            <p className="text-sm text-wrong">还差一点——点上面的「再听一遍」，听完改一改再交。</p>
                        )}
                        {answerError && <p className="text-sm text-wrong">{answerError}</p>}
                        {!settled ? (
                            <Button disabled={busy || !answer.trim()} onClick={() => void submit()}>
                                {busy ? '判卷中…' : result?.kind === 'retry' ? '再交一次' : '交答案'}
                            </Button>
                        ) : (
                            <div className="space-y-2">
                                <p
                                    className={`text-sm font-semibold ${result?.kind === 'correct' ? 'text-[color:var(--color-correct)]' : 'text-wrong'}`}
                                >
                                    {result?.kind === 'correct' ? '听懂了！' : '这题先看看原文怎么说的。'}
                                </p>
                                {result?.kind === 'reveal' && result.reference && (
                                    <p className="text-sm text-ink-soft">参考答案：{result.reference}</p>
                                )}
                                {result?.kind !== undefined && 'evidence' in result && result.evidence && (
                                    <p className="rounded-[10px] border border-rule bg-paper px-3 py-2 text-sm text-ink-soft">
                                        原文里是这句：{result.evidence}
                                    </p>
                                )}
                                <Button size="sm" onClick={next}>
                                    {index + 1 < opened.questions.length ? '下一题' : '做完了'}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <p className="text-sm text-ink-soft">
                听一段短文，然后回答几道题。短文不会出现在屏幕上——没听清就重听，不用急着作答。
            </p>
            {opening && (
                <p className="rounded-[10px] border border-rule bg-paper px-3 py-2 text-sm text-ink-soft">
                    正在合成语音，第一次要十几秒……
                </p>
            )}
            <ul className="grid gap-2 md:grid-cols-2">
                {list.map((p) => (
                    <li key={p.id} className="plate p-4 space-y-1">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="font-semibold text-ink">{p.title}</span>
                            <span className="text-xs text-ink-faint numeric">
                                {p.level} · {p.questionCount} 题
                            </span>
                        </div>
                        {openError?.id === p.id && <p className="text-sm text-wrong">{openError.message}</p>}
                        <Button size="sm" variant="secondary" disabled={Boolean(opening)} onClick={() => void open(p.id)}>
                            {opening === p.id ? '正在合成语音…' : openError?.id === p.id ? '再试一次' : '听这一篇'}
                        </Button>
                    </li>
                ))}
            </ul>
        </div>
    )
}
