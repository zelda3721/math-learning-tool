/**
 * HistoricalSessionView — read-only display for a previously persisted
 * session, loaded from `GET /sessions/{id}`.
 */
import { useMemo } from 'react'
import { ArrowLeft, FileCode2, MessageSquare, ThumbsDown, ThumbsUp, Wrench } from 'lucide-react'

import type { SessionDetail } from '../types/agent'

interface Props {
    detail: SessionDetail
    onBack: () => void
}

export function HistoricalSessionView({ detail, onBack }: Props) {
    const { session, quality, messages, tool_calls, artifacts, feedback } = detail
    const deliveryPassed = session.status === 'done' && quality?.quality_gate_passed === true

    // Retries append artifacts in chronological order. Always show the final
    // render that passed the quality gate, not the first failed attempt.
    const videoArtifact = useMemo(
        () => deliveryPassed
            ? [...artifacts].reverse().find((a) => a.kind === 'video')
            : undefined,
        [artifacts, deliveryPassed],
    )
    const manimArtifact = useMemo(
        () => [...artifacts].reverse().find((a) => a.kind === 'manim_code'),
        [artifacts],
    )
    const subtitleArtifact = useMemo(
        () => [...artifacts].reverse().find((a) => a.kind === 'subtitle'),
        [artifacts],
    )
    const videoUrl = pickVideoUrl(videoArtifact?.path, videoArtifact?.meta)
    const subtitleUrl = subtitleArtifact
        ? `/api/v1/sessions/${session.id}/artifacts/${subtitleArtifact.id}`
        : null

    return (
        <div className="space-y-4 animate-fade-in-up">
            <div className="flex items-center justify-between">
                <button
                    onClick={onBack}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-sky-600 text-sm transition"
                >
                    <ArrowLeft size={14} /> 返回新问题
                </button>
                <span className="text-xs text-slate-400">会话 {session.id.slice(0, 8)}</span>
            </div>

            {quality && (
                <div className="bento-card bg-white/70">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                        <h3 className="font-bold text-sm text-slate-700">成片质量报告</h3>
                        <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${quality.quality_gate_passed
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-amber-100 text-amber-700'
                            }`}>
                            {quality.overall_quality} · B {quality.b_total ?? '—'}/12
                        </span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <Metric label="首轮通过" value={quality.first_pass_success ? '是' : '否'} />
                        <Metric label="数学一致性" value={`${quality.math_consistency ?? '—'}/2`} />
                        <Metric label="本质兑现" value={`${quality.essence_delivery ?? '—'}/2`} />
                        <Metric label="工具总耗时" value={`${(quality.total_tool_latency_ms / 1000).toFixed(1)}s`} />
                        <Metric
                            label="视频规格"
                            value={quality.video.width
                                ? `${quality.video.width}×${quality.video.height} · ${Number(quality.video.fps ?? 0).toFixed(0)}fps`
                                : '—'}
                        />
                        <Metric
                            label="时长"
                            value={quality.video.duration_s != null ? `${Number(quality.video.duration_s).toFixed(1)}s` : '—'}
                        />
                        <Metric
                            label="重试次数"
                            value={String(Object.values(quality.retry_counts).reduce((sum, value) => sum + value, 0))}
                        />
                        <Metric label="技术门禁" value={quality.technical_pass ? '通过' : '未通过'} />
                        <Metric
                            label="讲解轨道"
                            value={quality.has_audio ? '旁白 + 字幕' : quality.has_subtitles ? '字幕' : '缺失'}
                        />
                    </div>
                </div>
            )}

            <div className="bento-card bg-white/70">
                <div className="flex items-center gap-2 text-slate-500 text-xs mb-1">
                    <span>{session.grade}</span>
                    <span>·</span>
                    <span>{new Date(session.created_at).toLocaleString()}</span>
                    <span>·</span>
                    <StatusPill status={session.status} />
                </div>
                <p className="text-lg text-slate-800 leading-relaxed">{session.problem}</p>
                {session.error && (
                    <p className="mt-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1">{session.error}</p>
                )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                <div
                    className={`bento-card ${manimArtifact ? 'md:col-span-8' : 'md:col-span-12'} bg-slate-900 min-h-[260px] border-none relative`}
                >
                    {videoUrl ? (
                        <video src={videoUrl} controls className="w-full h-full object-contain rounded-xl">
                            {subtitleUrl && (
                                <track
                                    kind="captions"
                                    src={subtitleUrl}
                                    srcLang="zh"
                                    label="中文讲解"
                                />
                            )}
                        </video>
                    ) : (
                        <div className="text-center text-slate-500 py-12">
                            {session.status === 'done'
                                ? '视频未通过质量门禁，候选未交付'
                                : '任务未完成，候选视频不作为成品展示'}
                        </div>
                    )}
                </div>
                {manimArtifact && (
                    <div className="bento-card md:col-span-4 bg-slate-50/80">
                        <div className="flex items-center gap-2 text-slate-600 mb-2">
                            <FileCode2 size={16} />
                            <h3 className="font-bold text-sm">代码归档路径</h3>
                        </div>
                        <p className="text-xs text-slate-600 break-all font-mono">
                            {manimArtifact.path}
                        </p>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bento-card bg-white/70">
                    <div className="flex items-center gap-2 text-slate-700 mb-3">
                        <Wrench size={16} />
                        <h3 className="font-bold text-sm">工具调用 ({tool_calls.length})</h3>
                    </div>
                    {tool_calls.length === 0 ? (
                        <p className="text-xs text-slate-400">无</p>
                    ) : (
                        <ul className="space-y-1.5 text-xs">
                            {tool_calls.map((tc) => (
                                <li
                                    key={tc.id}
                                    className="flex items-center gap-2 px-2 py-1.5 rounded border border-slate-100 bg-slate-50/40"
                                >
                                    <span
                                        className={`w-2 h-2 rounded-full ${tc.status === 'success'
                                            ? 'bg-emerald-400'
                                            : tc.status === 'failed'
                                                ? 'bg-red-400'
                                                : 'bg-slate-300'
                                            }`}
                                    />
                                    <code className="font-mono text-slate-700">{tc.name}</code>
                                    {tc.duration_ms != null && (
                                        <span className="text-slate-400 ml-auto">{tc.duration_ms} ms</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="bento-card bg-white/70">
                    <div className="flex items-center gap-2 text-slate-700 mb-3">
                        <MessageSquare size={16} />
                        <h3 className="font-bold text-sm">对话消息 ({messages.length})</h3>
                    </div>
                    <ul className="space-y-1.5 text-xs max-h-60 overflow-auto">
                        {messages.map((m) => (
                            <li key={m.id} className="flex items-start gap-2">
                                <span
                                    className={`mt-1 inline-block w-2 h-2 rounded-full ${m.role === 'user'
                                        ? 'bg-sky-400'
                                        : m.role === 'assistant'
                                            ? 'bg-violet-400'
                                            : 'bg-slate-300'
                                        }`}
                                />
                                <span className="font-mono text-slate-400 w-10 shrink-0">{m.role}</span>
                                <span className="text-slate-600 line-clamp-2 flex-1">{m.content || '(空)'}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>

            {feedback.length > 0 && (
                <div className="bento-card bg-white/70">
                    <h3 className="font-bold text-sm text-slate-700 mb-3">反馈记录</h3>
                    <ul className="space-y-2">
                        {feedback.map((f) => (
                            <li
                                key={f.id}
                                className="flex items-start gap-3 p-2 rounded-lg border border-slate-100"
                            >
                                <span
                                    className={`inline-flex items-center justify-center w-7 h-7 rounded-full ${f.label === 'good'
                                        ? 'bg-emerald-100 text-emerald-700'
                                        : f.label === 'bad'
                                            ? 'bg-red-100 text-red-700'
                                            : 'bg-slate-100 text-slate-500'
                                        }`}
                                >
                                    {f.label === 'good' ? (
                                        <ThumbsUp size={14} />
                                    ) : f.label === 'bad' ? (
                                        <ThumbsDown size={14} />
                                    ) : (
                                        '·'
                                    )}
                                </span>
                                <div className="flex-1">
                                    <p className="text-sm text-slate-700">{f.notes || '（无备注）'}</p>
                                    <p className="text-[11px] text-slate-400 mt-0.5">
                                        {new Date(f.created_at).toLocaleString()}
                                    </p>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2">
            <p className="text-slate-400 mb-0.5">{label}</p>
            <p className="font-semibold text-slate-700">{value}</p>
        </div>
    )
}

function StatusPill({ status }: { status: string }) {
    const cls =
        status === 'done'
            ? 'bg-emerald-100 text-emerald-700'
            : status === 'failed'
                ? 'bg-red-100 text-red-700'
                : status === 'running'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-slate-100 text-slate-600'
    return (
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${cls}`}>
            {status}
        </span>
    )
}

function pickVideoUrl(path: string | undefined, meta: Record<string, unknown> | undefined): string | null {
    if (!path) return null
    if (meta && typeof meta['url'] === 'string') return meta['url'] as string
    if (path.startsWith('/api/')) return path
    if (path.includes('videos/')) {
        const sub = path.split('videos/').slice(1).join('videos/')
        return `/api/v1/media/videos/${sub}`
    }
    return `/api/v1/media/videos/${path}`
}
