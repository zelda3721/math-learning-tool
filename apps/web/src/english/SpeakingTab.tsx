import { useCallback, useEffect, useRef, useState } from 'react'

import { Button, LoadingState, PageHeader } from '../ui'

/**
 * 英语口语对练（阶段 5）：角色扮演，语音全在本机。
 *
 * 三条界面纪律：
 * 1. **先能听懂、再能开口**：AI 每句话都带语音；没有语音后端时把话写出来，
 *    不让孩子面对一个哑巴界面。
 * 2. **说错了不打断**：导师用 recast——下一句话里自然带上正确说法；
 *    界面上不出现"你错了"三个字。
 * 3. **不打分**：结束时只列"你今天用到的表达 / 可以试试的说法"，
 *    没有分数、没有等级。
 */

interface Scenario {
    id: string
    title: string
    level: string
    goals: string[]
    expressions: string[]
}

interface Turn {
    role: 'child' | 'tutor' | 'blocked'
    text: string
}

interface SessionState {
    sessionId: string
    scenario: Scenario
    opening: string
    audio: string | null
    ttsAvailable: boolean
}

interface Summary {
    turns: number
    used: string[]
    tryNext: string[]
    childWords: number
}

function playBase64Wav(base64: string | null) {
    if (!base64) return
    try {
        const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
        const audio = new Audio(url)
        void audio.play().catch(() => {
            /* 自动播放被拦：让孩子自己点一下重听 */
        })
        audio.onended = () => URL.revokeObjectURL(url)
    } catch {
        /* 音频坏了不该挡住对话 */
    }
}

export function SpeakingTab({ learnerId }: { learnerId: string }) {
    const [scenarios, setScenarios] = useState<Scenario[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [session, setSession] = useState<SessionState | null>(null)
    const [turns, setTurns] = useState<Turn[]>([])
    const [busy, setBusy] = useState(false)
    const [recording, setRecording] = useState(false)
    const [typed, setTyped] = useState('')
    const [summary, setSummary] = useState<Summary | null>(null)
    const recorderRef = useRef<MediaRecorder | null>(null)
    const chunksRef = useRef<Blob[]>([])

    const load = useCallback(async () => {
        setError(null)
        try {
            const res = await fetch(`/api/v1/speaking/scenarios?learnerId=${encodeURIComponent(learnerId)}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as { scenarios: Scenario[] }
            setScenarios(data.scenarios)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        setScenarios(null)
        setSession(null)
        setTurns([])
        setSummary(null)
        void load()
    }, [load])

    const start = async (scenarioId: string) => {
        setBusy(true)
        setError(null)
        setSummary(null)
        try {
            const res = await fetch('/api/v1/speaking/session', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, scenarioId }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as SessionState
            setSession(data)
            setTurns([{ role: 'tutor', text: data.opening }])
            playBase64Wav(data.audio)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const send = async (payload: { audio?: string; text?: string }) => {
        if (!session || busy) return
        setBusy(true)
        setError(null)
        try {
            const res = await fetch('/api/v1/speaking/turn', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, sessionId: session.sessionId, ...payload }),
            })
            const data = (await res.json()) as {
                heard?: string
                reply?: string | null
                audio?: string | null
                blocked?: boolean
                error?: string
            }
            if (!res.ok) {
                setError(data.error ?? `HTTP ${res.status}`)
                return
            }
            if (data.heard && !data.blocked) setTurns((prev) => [...prev, { role: 'child', text: data.heard! }])
            if (data.blocked) setTurns((prev) => [...prev, { role: 'blocked', text: data.reply ?? '' }])
            else if (data.reply) setTurns((prev) => [...prev, { role: 'tutor', text: data.reply! }])
            if (!data.blocked) playBase64Wav(data.audio ?? null)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    /** 按住说话：松开就送出去。录不到麦克风就退到打字，而不是把这一轮吞掉。 */
    const startRecording = async () => {
        if (!session || busy || recording) return
        setError(null)
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            const recorder = new MediaRecorder(stream)
            chunksRef.current = []
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data)
            }
            recorder.onstop = async () => {
                stream.getTracks().forEach((t) => t.stop())
                const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
                if (blob.size === 0) return
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader()
                    reader.onload = () => resolve(String(reader.result))
                    reader.onerror = () => reject(reader.error)
                    reader.readAsDataURL(blob)
                })
                await send({ audio: dataUrl })
            }
            recorder.start()
            recorderRef.current = recorder
            setRecording(true)
        } catch {
            setError('没有拿到麦克风权限——可以直接打字说，或者去浏览器的网站设置里允许麦克风。')
        }
    }

    const stopRecording = () => {
        if (!recorderRef.current) return
        recorderRef.current.stop()
        recorderRef.current = null
        setRecording(false)
    }

    const end = async () => {
        if (!session) return
        setBusy(true)
        try {
            const res = await fetch('/api/v1/speaking/end', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, sessionId: session.sessionId }),
            })
            if (res.ok) {
                const data = (await res.json()) as { summary: Summary }
                setSummary(data.summary)
                setSession(null)
            }
        } finally {
            setBusy(false)
        }
    }

    if (error && !session) {
        return (
            <div className="plate p-6 space-y-2">
                <p className="text-sm text-wrong">口语对练加载失败：{error}</p>
                <Button size="sm" variant="secondary" onClick={() => void load()}>
                    重试
                </Button>
            </div>
        )
    }
    if (!scenarios) return <LoadingState text="正在准备情景……" />

    if (summary) {
        return (
            <div className="plate p-6 space-y-3">
                <PageHeader title="今天开口说了" subtitle={`${summary.turns} 轮 · 说了约 ${summary.childWords} 个英文词`} />
                <div className="space-y-2">
                    <p className="text-sm font-semibold text-ink">你用到的表达</p>
                    {summary.used.length ? (
                        <p className="text-sm text-ink-soft">{summary.used.join(' · ')}</p>
                    ) : (
                        <p className="text-sm text-ink-faint">这次还没用上预设的表达——下次试着说出来。</p>
                    )}
                    <p className="text-sm font-semibold text-ink pt-2">可以试试的说法</p>
                    <p className="text-sm text-ink-soft">{summary.tryNext.join(' · ') || '都试过了，很棒。'}</p>
                </div>
                <p className="text-xs text-ink-faint">口语不打分、也不算进掌握度——它记的是你今天说了什么。</p>
                <Button onClick={() => setSummary(null)}>再来一次</Button>
            </div>
        )
    }

    if (!session) {
        return (
            <div className="space-y-3">
                <p className="text-sm text-ink-soft">
                    挑一个情景，和 AI 扮演的角色用英语聊几句。说错了不要紧——它会用正确说法接你的话。
                </p>
                <ul className="grid gap-2 md:grid-cols-2">
                    {scenarios.map((s) => (
                        <li key={s.id} className="plate p-4 space-y-2">
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="font-semibold text-ink">{s.title}</span>
                                <span className="text-xs text-ink-faint numeric">{s.level}</span>
                            </div>
                            <p className="text-xs text-ink-faint">{s.goals.join(' · ')}</p>
                            <Button size="sm" disabled={busy} onClick={() => void start(s.id)}>
                                开始
                            </Button>
                        </li>
                    ))}
                </ul>
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <p className="font-semibold text-ink">{session.scenario.title}</p>
                    <p className="text-xs text-ink-faint">要练：{session.scenario.expressions.join(' · ')}</p>
                </div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void end()}>
                    结束并看小结
                </Button>
            </div>

            <ul className="space-y-2">
                {turns.map((t, i) => (
                    <li
                        key={`${i}-${t.role}`}
                        className={`rounded-[10px] px-3 py-2 text-sm max-w-[85%] ${
                            t.role === 'child'
                                ? 'ml-auto bg-beam-wash text-ink'
                                : t.role === 'blocked'
                                  ? 'bg-wrong-wash text-wrong'
                                  : 'bg-paper border border-rule text-ink-soft'
                        }`}
                    >
                        {t.text}
                    </li>
                ))}
            </ul>

            {error && <p className="text-sm text-wrong">{error}</p>}

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    onPointerDown={() => void startRecording()}
                    onPointerUp={stopRecording}
                    onPointerLeave={() => recording && stopRecording()}
                    disabled={busy || recording}
                >
                    {recording ? '松开发送…' : busy ? '在听你说…' : '按住说话'}
                </Button>
                <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="也可以打字说（麦克风不方便时）"
                    className="flex-1 min-w-[200px] px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px]"
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && typed.trim()) {
                            void send({ text: typed.trim() })
                            setTyped('')
                        }
                    }}
                />
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || !typed.trim()}
                    onClick={() => {
                        void send({ text: typed.trim() })
                        setTyped('')
                    }}
                >
                    发送
                </Button>
            </div>
            {!session.ttsAvailable && (
                <p className="text-xs text-ink-faint">
                    这台机器上还没有语音合成，所以这一轮只有文字——话都写在上面了。
                </p>
            )}
            <p className="text-xs text-ink-faint">说错了不用重来：它会用正确的说法接你的话。</p>
        </div>
    )
}
