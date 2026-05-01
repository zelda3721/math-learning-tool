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
    const { session, messages, tool_calls, artifacts, feedback } = detail

    const videoArtifact = useMemo(() => artifacts.find((a) => a.kind === 'video'), [artifacts])
    const manimArtifact = useMemo(
        () => artifacts.find((a) => a.kind === 'manim_code'),
        [artifacts],
    )
    const videoUrl = pickVideoUrl(videoArtifact?.path, videoArtifact?.meta)

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
                        <video src={videoUrl} controls className="w-full h-full object-contain rounded-xl" />
                    ) : (
                        <div className="text-center text-slate-500 py-12">未保存视频</div>
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
