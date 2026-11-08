import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, ErrorState, LoadingState } from '../ui'

/**
 * 英语写作：给一个任务，孩子写，AI 按量规给反馈。
 *
 * 界面上必须说清的两句话：
 * 1. **不打分、不进掌握度**——写作是 `ai_unverified`，同一段话可以这么写也可以那么写；
 * 2. 两次评分差得远时（服务端算出来的），直说"这次反馈不太稳，可以给家长看看"。
 *
 * 这里不给"范文"：给了孩子会照着抄，而写作要练的是自己想说什么。
 */

interface Prompt {
    id: string
    title: string
    level: string
    prompt: string
    minWords: number
    mustUse: string[]
    tips: string[]
}

interface Feedback {
    bands: { structure: number; vocabulary: number; grammar: number }
    tip: string
    praise: string
    inconsistent: boolean
    words: number
    verification: string
}

const BAND_LABEL: Record<keyof Feedback['bands'], string> = {
    structure: '结构',
    vocabulary: '词汇',
    grammar: '语法',
}

export function WritingTab({ learnerId }: { learnerId: string }) {
    const [prompts, setPrompts] = useState<Prompt[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [picked, setPicked] = useState<Prompt | null>(null)
    const [text, setText] = useState('')
    const [busy, setBusy] = useState(false)
    const [feedback, setFeedback] = useState<Feedback | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            const res = await fetch(`/api/v1/en/writing/prompts?learnerId=${encodeURIComponent(learnerId)}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as { prompts: Prompt[] }
            setPrompts(data.prompts)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        setPrompts(null)
        setPicked(null)
        setFeedback(null)
        void load()
    }, [load])

    const words = useMemo(() => text.trim().split(/\s+/).filter(Boolean).length, [text])

    const submit = async () => {
        if (!picked || !text.trim() || busy) return
        setBusy(true)
        setError(null)
        try {
            const res = await fetch('/api/v1/en/writing/submit', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, promptId: picked.id, text: text.trim() }),
            })
            const data = (await res.json()) as Feedback & { error?: string }
            if (!res.ok) {
                setError(data.error ?? `HTTP ${res.status}`)
                return
            }
            setFeedback(data)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    if (error && !prompts) return <ErrorState message={`写作加载失败：${error}`} onRetry={() => void load()} />
    if (!prompts) return <LoadingState text="正在取写作任务……" />

    if (!picked) {
        return (
            <div className="space-y-3">
                <p className="text-sm text-ink-soft">
                    挑一个任务写一段。写完 AI 会按结构、词汇、语法给反馈——**不打分，也不算进掌握度**。
                </p>
                <ul className="grid gap-2 md:grid-cols-2">
                    {prompts.map((p) => (
                        <li key={p.id} className="plate p-4 space-y-1">
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="font-semibold text-ink">{p.title}</span>
                                <span className="text-xs text-ink-faint numeric">
                                    {p.level} · 至少 {p.minWords} 词
                                </span>
                            </div>
                            <p className="text-xs text-ink-faint line-clamp-2">{p.prompt}</p>
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                    setPicked(p)
                                    setText('')
                                    setFeedback(null)
                                }}
                            >
                                写这个
                            </Button>
                        </li>
                    ))}
                </ul>
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                    <p className="font-semibold text-ink">{picked.title}</p>
                    <p className="text-xs text-ink-faint">{picked.prompt}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                    换一个任务
                </Button>
            </div>

            <div className="rounded-[10px] border border-rule bg-paper px-3 py-2 text-xs text-ink-faint space-y-1">
                <p>提示：{picked.tips.join('；')}</p>
                <p>尽量用上：{picked.mustUse.join(' / ')}</p>
            </div>

            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={7}
                maxLength={2000}
                placeholder="在这里写你的英文短文……"
                className="w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px]"
            />
            <div className="flex flex-wrap items-center gap-3">
                <Button disabled={busy || !text.trim()} onClick={() => void submit()}>
                    {busy ? '正在看……' : '交给 AI 看看'}
                </Button>
                <span className={`text-xs numeric ${words < picked.minWords ? 'text-ink-faint' : 'text-[color:var(--color-correct)]'}`}>
                    {words} 词（建议至少 {picked.minWords}）
                </span>
            </div>

            {error && <p className="text-sm text-wrong">{error}</p>}

            {feedback && (
                <div className="plate p-5 space-y-3">
                    <div className="grid grid-cols-3 gap-3">
                        {(Object.keys(feedback.bands) as (keyof Feedback['bands'])[]).map((k) => (
                            <div key={k} className="rounded-[10px] border border-rule bg-paper px-3 py-2 text-center">
                                <div className="text-xs text-ink-faint">{BAND_LABEL[k]}</div>
                                <div className="numeric text-lg font-semibold text-ink">{feedback.bands[k]}/5</div>
                            </div>
                        ))}
                    </div>
                    <p className="text-sm text-ink-soft">写得好的地方：{feedback.praise}</p>
                    <p className="text-sm text-ink">可以改一改：{feedback.tip}</p>
                    {feedback.inconsistent && (
                        <p className="text-sm text-wrong">
                            这次两次评分差得比较多，反馈可能不太稳——可以让家长看一眼这篇。
                        </p>
                    )}
                    <p className="text-xs text-ink-faint">
                        写作不打分、不算进掌握度：同一段话可以这么写，也可以那么写。
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                                setFeedback(null)
                                setText('')
                            }}
                        >
                            再写一版
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                            换一个任务
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
