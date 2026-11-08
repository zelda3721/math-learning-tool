import { useCallback, useEffect, useState } from 'react'

import { ErrorState, LoadingState } from '../ui'

/**
 * 家长看英语口语对练：练了几轮、说了什么。
 *
 * 内容受家长自己的「记录对话」开关管（和探索对话同一把锁）：关着就只有轮次。
 * 这里**没有分数**——口语是 ai_unverified，产品承诺过不打分、不进掌握度。
 */

interface SpeakingTurn {
    ts: string
    role: 'child' | 'tutor' | 'blocked'
    text: string
    latencyMs: number | null
}

interface SpeakingSession {
    id: string
    scenarioId: string
    startedAt: string
    endedAt: string | null
    turnCount: number
    turns: SpeakingTurn[]
}

export function SpeakingPanel({ learnerId }: { learnerId: string }) {
    const [data, setData] = useState<{ recording: boolean; sessions: SpeakingSession[] } | null>(null)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            const res = await fetch(`/api/v1/parent/speaking?learnerId=${encodeURIComponent(learnerId)}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setData((await res.json()) as { recording: boolean; sessions: SpeakingSession[] })
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        setData(null)
        void load()
    }, [load])

    if (error) return <ErrorState message={`口语记录加载失败：${error}`} onRetry={() => void load()} />
    if (!data) return <LoadingState text="正在取口语记录……" />

    return (
        <section className="plate p-6 space-y-3">
            <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-semibold text-ink">英语口语对练</h2>
                <span className="text-xs text-ink-faint numeric">{data.sessions.length} 次</span>
            </div>
            {data.sessions.length === 0 ? (
                <p className="text-sm text-ink-faint">还没有练过。孩子可以在「英语 → 开口说」里挑一个情景开始。</p>
            ) : (
                <ul className="space-y-2">
                    {data.sessions.slice(0, 5).map((s) => (
                        <li key={s.id} className="rounded-[10px] border border-rule bg-plate px-3 py-2 space-y-1">
                            <div className="flex items-center justify-between gap-3 text-xs text-ink-faint">
                                <span>{s.scenarioId}</span>
                                <span className="numeric">
                                    {s.startedAt.slice(5, 16).replace('T', ' ')} · {s.turnCount} 轮
                                </span>
                            </div>
                            {!data.recording && (
                                <p className="text-xs text-ink-faint">内容记录是关着的（家长中心 → 对话记录可以打开）</p>
                            )}
                            {s.turns
                                .filter((t) => t.role !== 'blocked')
                                .slice(0, 6)
                                .map((t, i) => (
                                    <p key={`${t.ts}-${i}`} className="text-sm text-ink-soft">
                                        <span className="text-ink-faint">{t.role === 'child' ? '孩子：' : 'AI：'}</span>
                                        {t.text}
                                    </p>
                                ))}
                        </li>
                    ))}
                </ul>
            )}
            <p className="text-xs text-ink-faint">口语不打分，只记"练了多久、说了什么"。</p>
        </section>
    )
}
