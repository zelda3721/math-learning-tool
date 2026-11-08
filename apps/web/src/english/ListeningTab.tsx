import { useCallback, useEffect, useRef, useState } from 'react'

import { Button, ErrorState, LoadingState } from '../ui'

/**
 * 英语听力：听短文，答理解题。
 *
 * 关键的一条：**短文本身不下发**。这一页拿到的只有音频和题面，
 * 原文要等答完才以「原文依据」的形式出现——那是讲解，不是考卷。
 *
 * 没听清可以重听，不限次数：听力考的是听懂，不是记性。
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
    const [busy, setBusy] = useState(false)
    const [index, setIndex] = useState(0)
    const [answer, setAnswer] = useState('')
    const [result, setResult] = useState<{ correct: boolean; evidence: string; reference?: string } | null>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            const res = await fetch(`/api/v1/en/listening/list?learnerId=${encodeURIComponent(learnerId)}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as { passages: PassageSummary[] }
            setList(data.passages)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
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
        setBusy(true)
        setError(null)
        setResult(null)
        setIndex(0)
        setAnswer('')
        try {
            const res = await fetch(`/api/v1/en/listening/passage/${encodeURIComponent(id)}?learnerId=${encodeURIComponent(learnerId)}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as PassageAudio
            setOpened(data)
            play(data.audio)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const submit = async () => {
        if (!opened || !answer.trim()) return
        const q = opened.questions[index]
        if (!q) return
        setBusy(true)
        try {
            const res = await fetch('/api/v1/en/listening/answer', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, passageId: opened.id, questionId: q.id, answer: answer.trim() }),
            })
            const data = (await res.json()) as { correct: boolean; evidence: string; reference?: string; error?: string }
            if (!res.ok) {
                setError(data.error ?? `HTTP ${res.status}`)
                return
            }
            setResult(data)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const next = () => {
        if (!opened) return
        setResult(null)
        setAnswer('')
        if (index + 1 < opened.questions.length) setIndex(index + 1)
    }

    if (error) return <ErrorState message={`听力加载失败：${error}`} onRetry={() => void load()} />
    if (!list) return <LoadingState text="正在取听力材料……" />

    if (opened) {
        const q = opened.questions[index]
        const done = !q
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
                        <Button size="sm" variant="ghost" onClick={() => setOpened(null)}>
                            换一篇
                        </Button>
                    </div>
                </div>

                {!opened.ttsAvailable && (
                    <p className="rounded-[10px] border border-rule bg-paper px-3 py-2 text-sm text-ink-faint">
                        {opened.note}
                    </p>
                )}

                {done ? (
                    <p className="text-sm text-[color:var(--color-correct)]">这一篇的题都做完了。</p>
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
                            disabled={Boolean(result)}
                            className="w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px]"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !result) void submit()
                            }}
                        />
                        {!result ? (
                            <Button disabled={busy || !answer.trim()} onClick={() => void submit()}>
                                {busy ? '判卷中…' : '交答案'}
                            </Button>
                        ) : (
                            <div className="space-y-2">
                                <p className={`text-sm font-semibold ${result.correct ? 'text-[color:var(--color-correct)]' : 'text-wrong'}`}>
                                    {result.correct ? '听懂了！' : '还差一点——再听一遍这一段。'}
                                </p>
                                {!result.correct && result.reference && (
                                    <p className="text-sm text-ink-soft">参考答案：{result.reference}</p>
                                )}
                                <p className="rounded-[10px] border border-rule bg-paper px-3 py-2 text-sm text-ink-soft">
                                    原文里是这句：{result.evidence}
                                </p>
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
            <ul className="grid gap-2 md:grid-cols-2">
                {list.map((p) => (
                    <li key={p.id} className="plate p-4 space-y-1">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="font-semibold text-ink">{p.title}</span>
                            <span className="text-xs text-ink-faint numeric">
                                {p.level} · {p.questionCount} 题
                            </span>
                        </div>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void open(p.id)}>
                            听这一篇
                        </Button>
                    </li>
                ))}
            </ul>
        </div>
    )
}
