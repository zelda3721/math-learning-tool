import { useEffect, useRef, useState } from 'react'
import {
    fetchExplainJob,
    requestExplain,
    type ExplainFallback,
    type ExplainRequest,
    type Explanation,
} from './api'

/**
 * 讲解视图：ready 直接放视频；generating 先渲染图文兜底并 3s 轮询任务，
 * done 原地切视频；failed/offline 保留图文 + 小字说明（不空手失败）。
 */

type ViewState =
    | { kind: 'loading' }
    | { kind: 'video'; explanation: Explanation }
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

const FAILED_NOTE = '视频生成失败，先看文字讲解'

export function ExplanationView({ request, primaryLabel, onPrimary, onSkip }: Props) {
    const [state, setState] = useState<ViewState>({ kind: 'loading' })
    // request 是调用方内联对象：只在挂载时发一次，避免引用变化反复请求
    const requestRef = useRef(request)

    useEffect(() => {
        let cancelled = false
        void requestExplain(requestRef.current)
            .then((res) => {
                if (cancelled) return
                if (res.status === 'ready') {
                    setState({ kind: 'video', explanation: res.explanation })
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

    // 3s 轮询生成任务，done 原地切视频，failed 保留图文
    const jobId = state.kind === 'fallback' ? state.jobId : undefined
    useEffect(() => {
        if (!jobId) return
        let cancelled = false
        const timer = window.setInterval(() => {
            void fetchExplainJob(jobId)
                .then((job) => {
                    if (cancelled) return
                    if (job.status === 'done' && job.explanation) {
                        setState({ kind: 'video', explanation: job.explanation })
                    } else if (job.status === 'failed') {
                        setState((prev) =>
                            prev.kind === 'fallback'
                                ? { kind: 'fallback', fallback: prev.fallback, note: FAILED_NOTE }
                                : prev
                        )
                    }
                })
                .catch(() => {
                    if (cancelled) return
                    setState((prev) =>
                        prev.kind === 'fallback'
                            ? { kind: 'fallback', fallback: prev.fallback, note: FAILED_NOTE }
                            : prev
                    )
                })
        }, 3000)
        return () => {
            cancelled = true
            window.clearInterval(timer)
        }
    }, [jobId])

    return (
        <div className="space-y-5">
            <h3 className="text-lg font-bold text-slate-700 text-center">讲给你听</h3>

            {state.kind === 'loading' && (
                <div className="text-center text-slate-400 py-10">正在准备讲解……</div>
            )}

            {state.kind === 'error' && (
                <div className="rounded-2xl bg-red-50 border border-red-200 px-4 py-3 text-red-500 text-sm">
                    讲解没取到：{state.message}
                </div>
            )}

            {state.kind === 'video' && (
                <video
                    controls
                    autoPlay
                    src={state.explanation.videoUrl}
                    className="w-full rounded-2xl bg-black shadow-lg"
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

            {state.kind === 'fallback' && (
                <div className="space-y-4">
                    {state.jobId && !state.note && (
                        <div className="rounded-2xl bg-sky-50 border border-sky-200 px-4 py-2.5 text-sm text-sky-600 font-medium">
                            🎬 视频生成中…先看文字版
                        </div>
                    )}
                    <FallbackContent fallback={state.fallback} />
                    {state.note && <p className="text-xs text-slate-400">{state.note}</p>}
                </div>
            )}

            <div className="flex flex-col items-center gap-2 pt-1">
                <button
                    type="button"
                    onClick={onPrimary}
                    className="px-8 py-3 rounded-2xl bg-violet-500 text-white text-lg font-bold shadow-lg shadow-violet-200 hover:bg-violet-600 transition-colors"
                >
                    {primaryLabel}
                </button>
                {onSkip && (
                    <button
                        type="button"
                        onClick={onSkip}
                        className="text-xs text-slate-400 underline hover:text-slate-500"
                    >
                        先跳过
                    </button>
                )}
            </div>
        </div>
    )
}

/** 图文兜底：节点是什么/为什么 + 依据链 + 常见坑 + 题目解析 */
function FallbackContent({ fallback }: { fallback: ExplainFallback }) {
    const empty =
        !fallback.rootNode && !fallback.chainNames?.length && !fallback.misconceptionDesc && !fallback.analysis
    if (empty) {
        return <p className="text-sm text-slate-400 text-center py-4">暂时没有文字讲解。</p>
    }
    return (
        <div className="space-y-3 text-left">
            {fallback.rootNode && (
                <div className="rounded-2xl bg-white/70 border border-slate-100 px-4 py-3 space-y-2">
                    <p className="text-lg font-bold text-indigo-600">{fallback.rootNode.name}</p>
                    {fallback.rootNode.whatIsIt && (
                        <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">
                            <span className="text-xs font-bold text-slate-400 mr-2">是什么</span>
                            {fallback.rootNode.whatIsIt}
                        </p>
                    )}
                    {fallback.rootNode.why && (
                        <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">
                            <span className="text-xs font-bold text-slate-400 mr-2">为什么</span>
                            {fallback.rootNode.why}
                        </p>
                    )}
                </div>
            )}
            {fallback.chainNames && fallback.chainNames.length > 0 && (
                <div className="rounded-2xl bg-indigo-50/60 border border-indigo-100 px-4 py-3">
                    <p className="text-xs font-bold text-indigo-400 mb-1">知识链</p>
                    <p className="text-sm text-indigo-700">{fallback.chainNames.join(' → ')}</p>
                </div>
            )}
            {fallback.misconceptionDesc && (
                <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3">
                    <p className="text-xs font-bold text-amber-500 mb-1">常见的坑</p>
                    <p className="text-amber-800 whitespace-pre-wrap">{fallback.misconceptionDesc}</p>
                </div>
            )}
            {fallback.analysis && (
                <div className="rounded-2xl bg-white/70 border border-slate-100 px-4 py-3">
                    <p className="text-xs font-bold text-slate-400 mb-1">题目解析</p>
                    <p className="text-slate-600 leading-relaxed whitespace-pre-wrap">{fallback.analysis}</p>
                </div>
            )}
        </div>
    )
}
