/**
 * 讲解 tab 的 Web 动画模式：自由输入题目 → /api/v1/explain → 轮询 → 渲染。
 * 视频（Manim）走原 SSE 流程，不在此组件。
 *
 * 两种产物都要认：`web` 给 SceneSpec 交给 ExplainerPlayer，
 * `web_html` 给模型直写的页面放进 sandbox iframe。
 * 只认 specUrl 会让 EXPLAIN_WEB_MODE=web_html/both 时这里**整片空白**——
 * 任务明明成功了，页面上什么都没有，最难查的那种。
 */
import { useEffect, useRef, useState } from 'react'
import { ExplainerPlayer, validateSpec } from '@mathtutor/explainer-web'
import {
    fetchExplainJob,
    fetchSpec,
    requestExplain,
    type Explanation,
} from '../practice/api'
import { GeneratedExplanation } from '../practice/GeneratedExplanation'
import { ExplanationCompare } from '../practice/ExplanationCompare'
import { LoadingState } from '../ui'

type Phase =
    | { kind: 'generating'; jobId?: string }
    | { kind: 'ready'; explanation: Explanation; alternatives: Explanation[] }
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
                if (res.status === 'ready')
                    setPhase({
                        kind: 'ready',
                        explanation: res.explanation,
                        alternatives: res.alternatives ?? [],
                    })
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
                    setPhase({
                        kind: 'ready',
                        explanation: job.explanation,
                        alternatives: job.alternatives ?? [],
                    })
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
        <div className="plate p-5 space-y-3">
            {phase.kind === 'generating' && (
                <LoadingState text="动画讲解生成中（解题 → 验算 → 视觉导演，通常一两分钟）" />
            )}
            {phase.kind === 'failed' && (
                <p className="text-sm text-wrong">
                    动画生成失败：{phase.message}，可切换「视频」模式重试。
                </p>
            )}
            {phase.kind === 'ready' && (
                <ReadyView
                    explanation={phase.explanation}
                    alternatives={phase.alternatives}
                    onSelect={(next, rest) =>
                        setPhase({ kind: 'ready', explanation: next, alternatives: rest })
                    }
                />
            )}
        </div>
    )
}

/** 按产物形态选渲染器；两种都不认时说清楚，而不是留一片空白 */
function ReadyView({
    explanation,
    alternatives,
    onSelect,
}: {
    explanation: Explanation
    alternatives: Explanation[]
    onSelect: (next: Explanation, rest: Explanation[]) => void
}) {
    const switcher =
        alternatives.length > 0 ? (
            <ExplanationCompare
                current={explanation}
                alternatives={alternatives}
                onSelect={(next) =>
                    onSelect(
                        next,
                        [...alternatives.filter((e) => e.id !== next.id), explanation],
                    )
                }
            />
        ) : null

    if (explanation.htmlUrl) {
        return (
            <div className="space-y-2">
                <GeneratedExplanation htmlUrl={explanation.htmlUrl} quality={explanation.quality} />
                {switcher}
            </div>
        )
    }
    if (explanation.specUrl) {
        return (
            <div className="space-y-2">
                <SpecPlayer specUrl={explanation.specUrl} />
                {switcher}
            </div>
        )
    }
    return (
        <p className="text-sm text-ink-faint">
            这份讲解没有可播放的产物（模式 {explanation.mode}），可切换「视频」模式重试。
        </p>
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

    if (error) return <p className="text-sm text-wrong">动画数据异常：{error}</p>
    return (
        <div>
            <div ref={containerRef} className="w-full" />
            {beat && (
                <p className="text-xs text-ink-faint mt-2 text-center">
                    第 <span className="numeric">{beat.i + 1}/{beat.total}</span> 拍
                </p>
            )}
        </div>
    )
}
