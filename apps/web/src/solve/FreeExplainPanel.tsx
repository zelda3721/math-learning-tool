/**
 * 讲解 tab 的 Web 动画模式：自由输入题目 → /api/v1/explain（web 默认）
 * → 轮询 → SceneSpec → ExplainerPlayer。视频（Manim）走原 SSE 流程，不在此组件。
 */
import { useEffect, useRef, useState } from 'react'
import { ExplainerPlayer, validateSpec } from '@mathtutor/explainer-web'
import {
    fetchExplainJob,
    fetchSpec,
    requestExplain,
    type Explanation,
} from '../practice/api'

type Phase =
    | { kind: 'generating'; jobId?: string }
    | { kind: 'ready'; explanation: Explanation }
    | { kind: 'failed'; message: string }

export function FreeExplainPanel({ problem, grade }: { problem: string; grade: string }) {
    const [phase, setPhase] = useState<Phase>({ kind: 'generating' })

    // 发起请求（problem/grade 变化即重来）
    useEffect(() => {
        let cancelled = false
        setPhase({ kind: 'generating' })
        requestExplain({ problem, grade })
            .then((res) => {
                if (cancelled) return
                if (res.status === 'ready') setPhase({ kind: 'ready', explanation: res.explanation })
                else if (res.status === 'generating') setPhase({ kind: 'generating', jobId: res.jobId })
                else setPhase({ kind: 'failed', message: res.message })
            })
            .catch((err) => !cancelled && setPhase({ kind: 'failed', message: String(err) }))
        return () => {
            cancelled = true
        }
    }, [problem, grade])

    // 轮询任务
    useEffect(() => {
        if (phase.kind !== 'generating' || !phase.jobId) return
        const jobId = phase.jobId
        const timer = setInterval(async () => {
            try {
                const job = await fetchExplainJob(jobId)
                if (job.status === 'done' && job.explanation) {
                    clearInterval(timer)
                    setPhase({ kind: 'ready', explanation: job.explanation })
                } else if (job.status === 'failed') {
                    clearInterval(timer)
                    setPhase({ kind: 'failed', message: job.error ?? '生成失败' })
                }
            } catch {
                /* 下一轮再试 */
            }
        }, 3000)
        return () => clearInterval(timer)
    }, [phase])

    return (
        <div className="soft-glass p-6 space-y-3">
            {phase.kind === 'generating' && (
                <p className="text-slate-500 text-sm animate-pulse">
                    ⚡ 动画讲解生成中（解题 → 验算 → 视觉导演，通常一两分钟）……
                </p>
            )}
            {phase.kind === 'failed' && (
                <p className="text-sm text-red-500">动画生成失败：{phase.message}，可切换「🎬 视频」模式重试。</p>
            )}
            {phase.kind === 'ready' && phase.explanation.specUrl && (
                <SpecPlayer specUrl={phase.explanation.specUrl} />
            )}
        </div>
    )
}

function SpecPlayer({ specUrl }: { specUrl: string }) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const [beat, setBeat] = useState<{ i: number; total: number } | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let player: ExplainerPlayer | null = null
        let cancelled = false
        fetchSpec(specUrl)
            .then((raw) => {
                if (cancelled || !containerRef.current) return
                const { spec, errors } = validateSpec(raw)
                if (!spec || errors.length) {
                    setError(errors[0] ?? '动画数据异常')
                    return
                }
                player = new ExplainerPlayer(containerRef.current, spec, {
                    autoPlay: true,
                    onBeatChange: (i, total) => setBeat({ i, total }),
                })
            })
            .catch((err) => !cancelled && setError(String(err)))
        return () => {
            cancelled = true
            player?.destroy()
        }
    }, [specUrl])

    if (error) return <p className="text-sm text-red-500">动画数据异常：{error}</p>
    return (
        <div>
            <div ref={containerRef} className="w-full" />
            {beat && (
                <p className="text-xs text-slate-400 mt-2 text-center">
                    第 {beat.i + 1}/{beat.total} 拍
                </p>
            )}
        </div>
    )
}
