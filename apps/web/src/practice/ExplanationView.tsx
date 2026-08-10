import { useEffect, useRef, useState } from 'react'
import { ExplainerPlayer, validateSpec } from '@mathtutor/explainer-web'
import {
    fetchExplainJob,
    fetchSpec,
    requestExplain,
    type ExplainFallback,
    type ExplainRequest,
    type Explanation,
    type SceneSpec,
} from './api'
import { Button } from '../ui'
import { GeneratedExplanation } from './GeneratedExplanation'
import { ExplanationCompare } from './ExplanationCompare'

/**
 * 讲解视图：默认 mode:'web' 动态讲解——ready/job done 后拉 SceneSpec 挂 ExplainerPlayer；
 * generating 先渲染图文兜底并 3s 轮询任务；spec 校验失败/failed/offline 保留图文 + 小字说明（不空手失败）。
 * 动画下方提供「生成高级视频」小按钮，切 mode:'video' 走原 Manim 流程，生成完成原地切 <video>。
 */

type ViewState =
    | { kind: 'loading' }
    | { kind: 'video'; explanation: Explanation }
    | {
          kind: 'web'
          spec: SceneSpec
          fallback: ExplainFallback
          videoJobId?: string
          videoNote?: string
          explanation?: Explanation
          alternatives?: Explanation[]
      }
    // 模型直写的页面：只拿 URL，内容放进 sandbox iframe，绝不同源执行
    | {
          kind: 'html'
          htmlUrl: string
          quality?: string
          fallback: ExplainFallback
          explanation: Explanation
          alternatives?: Explanation[]
      }
    | { kind: 'fallback'; fallback: ExplainFallback; jobId?: string; note?: string }
    | { kind: 'error'; message: string }

interface Props {
    request: ExplainRequest
    /** 主按钮文案（做题流程中为「去做变式题」，小结页复用时为「关闭」） */
    primaryLabel: string
    onPrimary: () => void
    /** 不显眼的小字「先跳过」链接；不传则不渲染 */
    onSkip?: () => void
}

const FAILED_NOTE = '动画生成失败，先看文字讲解'
const SPEC_BROKEN_NOTE = '动画数据异常，先看文字讲解'
const VIDEO_FAILED_NOTE = '视频生成失败，可稍后再试'

export function ExplanationView({ request, primaryLabel, onPrimary, onSkip }: Props) {
    const [state, setState] = useState<ViewState>({ kind: 'loading' })
    // request 是调用方内联对象：只在挂载时发一次，避免引用变化反复请求
    const requestRef = useRef(request)
    // applyExplanation 由挂载 effect 定义（共享其 cancelled 标志），轮询 effect 经 ref 复用
    const applyRef = useRef<
        (explanation: Explanation, fallback: ExplainFallback, alternatives?: Explanation[]) => void
    >(() => {})
    // 最近一次拿到的图文兜底：轮询 done 时作为 spec 异常的退路
    const fallbackRef = useRef<ExplainFallback>({})

    useEffect(() => {
        let cancelled = false

        /** ready/done 拿到 explanation 后统一落地：web → 拉 spec 校验挂播放器；video → 原地放视频 */
        const applyExplanation = (
            explanation: Explanation,
            fallback: ExplainFallback,
            alternatives: Explanation[] = [],
        ) => {
            fallbackRef.current = fallback
            if (explanation.mode === 'web_html' && explanation.htmlUrl) {
                setState({
                    kind: 'html',
                    htmlUrl: explanation.htmlUrl,
                    quality: explanation.quality,
                    fallback,
                    explanation,
                    alternatives,
                })
            } else if (explanation.mode === 'web' && explanation.specUrl) {
                void fetchSpec(explanation.specUrl)
                    .then((raw) => {
                        if (cancelled) return
                        const { spec, errors } = validateSpec(raw)
                        if (spec && errors.length === 0) {
                            setState({ kind: 'web', spec, fallback, explanation, alternatives })
                        } else {
                            setState({ kind: 'fallback', fallback, note: SPEC_BROKEN_NOTE })
                        }
                    })
                    .catch(() => {
                        if (!cancelled) setState({ kind: 'fallback', fallback, note: SPEC_BROKEN_NOTE })
                    })
            } else if (explanation.videoUrl) {
                setState({ kind: 'video', explanation })
            } else {
                setState({ kind: 'fallback', fallback, note: FAILED_NOTE })
            }
        }
        applyRef.current = applyExplanation

        void requestExplain(requestRef.current)
            .then((res) => {
                if (cancelled) return
                fallbackRef.current = res.fallback
                if (res.status === 'ready') {
                    applyExplanation(res.explanation, res.fallback, res.alternatives ?? [])
                } else if (res.status === 'generating') {
                    setState({ kind: 'fallback', fallback: res.fallback, jobId: res.jobId })
                } else {
                    setState({ kind: 'fallback', fallback: res.fallback, note: res.message || FAILED_NOTE })
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
                }
            })
        return () => {
            cancelled = true
        }
    }, [])

    // 3s 轮询生成任务：初始 web 任务（fallback.jobId）与高级视频任务（web.videoJobId）共用一套轮询
    const pollJobId =
        state.kind === 'fallback' ? state.jobId : state.kind === 'web' ? state.videoJobId : undefined
    useEffect(() => {
        if (!pollJobId) return
        let cancelled = false
        const markFailed = () => {
            setState((prev) => {
                if (prev.kind === 'fallback') {
                    return { kind: 'fallback', fallback: prev.fallback, note: FAILED_NOTE }
                }
                if (prev.kind === 'web') {
                    return { ...prev, videoJobId: undefined, videoNote: VIDEO_FAILED_NOTE }
                }
                return prev
            })
        }
        const timer = window.setInterval(() => {
            void fetchExplainJob(pollJobId)
                .then((job) => {
                    if (cancelled) return
                    if (job.status === 'done' && job.explanation) {
                        applyRef.current(job.explanation, fallbackRef.current, job.alternatives ?? [])
                    } else if (job.status === 'failed') {
                        markFailed()
                    }
                })
                .catch(() => {
                    if (!cancelled) markFailed()
                })
        }, 3000)
        return () => {
            cancelled = true
            window.clearInterval(timer)
        }
    }, [pollJobId])

    /** 换到另一份讲法：两份都已生成，纯本地切换，不再调引擎 */
    const switchTo = (next: Explanation) => {
        const current =
            state.kind === 'html' ? state.explanation : state.kind === 'web' ? state.explanation : undefined
        const others = (state.kind === 'html' || state.kind === 'web' ? state.alternatives : undefined) ?? []
        const rest = [...others.filter((e) => e.id !== next.id), ...(current ? [current] : [])]
        applyRef.current(next, fallbackRef.current, rest)
    }

    // 「生成高级视频」：显式 mode:'video' 走原 Manim 流程；已有缓存（ready 且 videoUrl）直接切视频
    const requestVideo = () => {
        setState((prev) => (prev.kind === 'web' ? { ...prev, videoNote: undefined } : prev))
        void requestExplain(requestRef.current, 'video')
            .then((res) => {
                if (res.status === 'ready' && res.explanation.videoUrl) {
                    setState({ kind: 'video', explanation: res.explanation })
                } else if (res.status === 'generating') {
                    setState((prev) => (prev.kind === 'web' ? { ...prev, videoJobId: res.jobId } : prev))
                } else {
                    setState((prev) =>
                        prev.kind === 'web'
                            ? { ...prev, videoNote: 'message' in res ? res.message : VIDEO_FAILED_NOTE }
                            : prev
                    )
                }
            })
            .catch(() => {
                setState((prev) => (prev.kind === 'web' ? { ...prev, videoNote: VIDEO_FAILED_NOTE } : prev))
            })
    }

    return (
        <div className="space-y-5">
            <h3 className="text-section text-center">讲给你听</h3>

            {state.kind === 'loading' && (
                <div className="text-center text-ink-faint py-10">正在准备讲解……</div>
            )}

            {state.kind === 'error' && (
                <div className="rounded-[10px] bg-wrong-wash border border-wrong/25 px-4 py-3 text-wrong text-sm">
                    讲解没取到：{state.message}
                </div>
            )}

            {state.kind === 'video' && (
                <video
                    controls
                    autoPlay
                    src={state.explanation.videoUrl}
                    className="w-full rounded-[14px] border border-rule bg-black"
                >
                    {state.explanation.subtitleUrl && (
                        <track
                            kind="subtitles"
                            src={state.explanation.subtitleUrl}
                            srcLang="zh"
                            label="中文"
                            default
                        />
                    )}
                </video>
            )}

            {state.kind === 'web' && (
                <div className="space-y-2">
                    <WebPlayer spec={state.spec} />
                    {state.explanation && state.alternatives && state.alternatives.length > 0 && (
                        <ExplanationCompare
                            current={state.explanation}
                            alternatives={state.alternatives}
                            learnerId={requestRef.current.learnerId}
                            onSelect={switchTo}
                        />
                    )}
                    <div className="flex items-center justify-center gap-3">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={requestVideo}
                            disabled={Boolean(state.videoJobId)}
                        >
                            {state.videoJobId ? '🎬 视频生成中…' : '🎬 生成高级视频'}
                        </Button>
                        {state.videoNote && <span className="text-xs text-ink-faint">{state.videoNote}</span>}
                    </div>
                </div>
            )}

            {state.kind === 'html' && (
                <div className="space-y-2">
                    <GeneratedExplanation htmlUrl={state.htmlUrl} quality={state.quality} />
                    {state.alternatives && state.alternatives.length > 0 && (
                        <ExplanationCompare
                            current={state.explanation}
                            alternatives={state.alternatives}
                            learnerId={requestRef.current.learnerId}
                            onSelect={switchTo}
                        />
                    )}
                    <div className="flex items-center justify-center">
                        <Button size="sm" variant="secondary" onClick={requestVideo}>
                            🎬 生成高级视频
                        </Button>
                    </div>
                </div>
            )}

            {state.kind === 'fallback' && (
                <div className="space-y-4">
                    {state.jobId && !state.note && (
                        <div className="rounded-[10px] bg-beam-wash border border-beam/20 px-4 py-2.5 text-sm text-beam font-medium">
                            ⚡ 动画讲解生成中…先看文字版
                        </div>
                    )}
                    <FallbackContent fallback={state.fallback} />
                    {state.note && <p className="text-xs text-ink-faint">{state.note}</p>}
                </div>
            )}

            <div className="flex flex-col items-center gap-2 pt-1">
                <Button size="lg" onClick={onPrimary}>
                    {primaryLabel}
                </Button>
                {onSkip && (
                    <Button size="sm" variant="ghost" onClick={onSkip} className="underline">
                        先跳过
                    </Button>
                )}
            </div>
        </div>
    )
}

/** web 动态讲解：受控挂载 ExplainerPlayer（autoPlay），显示 第 i/total 拍 */
function WebPlayer({ spec }: { spec: SceneSpec }) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [beat, setBeat] = useState<{ i: number; total: number } | null>(null)
    const playerRef = useRef<ExplainerPlayer | null>(null)

    useEffect(() => {
        const el = containerRef.current
        if (!el) return
        const player = new ExplainerPlayer(el, spec, {
            autoPlay: true,
            onBeatChange: (i, total) => setBeat({ i, total }),
        })
        playerRef.current = player
        return () => {
            playerRef.current = null
            player.destroy()
        }
    }, [spec])

    return (
        <div className="space-y-2">
            <div ref={containerRef} className="plate w-full overflow-hidden" />
            <div className="flex items-center justify-center gap-3 text-xs text-ink-faint">
                <Button size="sm" variant="ghost" onClick={() => playerRef.current?.prev()}>
                    ⏮ 上一拍
                </Button>
                {beat && (
                    <span className="numeric">
                        第 {beat.i + 1} / {beat.total} 拍
                    </span>
                )}
                <Button size="sm" variant="ghost" onClick={() => playerRef.current?.next()}>
                    下一拍 ⏭
                </Button>
            </div>
        </div>
    )
}

/** 图文兜底：节点是什么/为什么 + 依据链 + 常见坑 + 题目解析 */
function FallbackContent({ fallback }: { fallback: ExplainFallback }) {
    const empty =
        !fallback.rootNode && !fallback.chainNames?.length && !fallback.misconceptionDesc && !fallback.analysis
    if (empty) {
        return <p className="text-sm text-ink-faint text-center py-4">暂时没有文字讲解。</p>
    }
    return (
        <div className="space-y-3 text-left">
            {fallback.rootNode && (
                <div className="rounded-[10px] bg-paper border border-rule px-4 py-3 space-y-2">
                    <p className="text-lg font-bold text-ink">{fallback.rootNode.name}</p>
                    {fallback.rootNode.whatIsIt && (
                        <div className="space-y-1">
                            <p className="eyebrow">是什么</p>
                            <p className="text-ink-soft leading-relaxed whitespace-pre-wrap">
                                {fallback.rootNode.whatIsIt}
                            </p>
                        </div>
                    )}
                    {fallback.rootNode.why && (
                        <div className="space-y-1">
                            <p className="eyebrow">为什么</p>
                            <p className="text-ink-soft leading-relaxed whitespace-pre-wrap">
                                {fallback.rootNode.why}
                            </p>
                        </div>
                    )}
                </div>
            )}
            {fallback.chainNames && fallback.chainNames.length > 0 && (
                <div className="rounded-[10px] bg-beam-wash border border-beam/20 px-4 py-3">
                    <p className="eyebrow mb-1.5">知识链</p>
                    <p className="text-sm text-ink-soft">{fallback.chainNames.join(' → ')}</p>
                </div>
            )}
            {fallback.misconceptionDesc && (
                <div className="rounded-[10px] bg-wrong-wash border border-wrong/20 px-4 py-3">
                    <p className="eyebrow mb-1.5">常见的坑</p>
                    <p className="text-ink-soft leading-relaxed whitespace-pre-wrap">
                        {fallback.misconceptionDesc}
                    </p>
                </div>
            )}
            {fallback.analysis && (
                <div className="rounded-[10px] bg-paper border border-rule px-4 py-3">
                    <p className="eyebrow mb-1.5">题目解析</p>
                    <p className="text-ink-soft leading-relaxed whitespace-pre-wrap">{fallback.analysis}</p>
                </div>
            )}
        </div>
    )
}
