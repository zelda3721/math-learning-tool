/**
 * HistoricalSessionView — 已归档会话的只读视图，数据来自 `GET /sessions/{id}`。
 */
import { useMemo } from 'react'
import { ArrowLeft, ThumbsDown, ThumbsUp } from 'lucide-react'

import type { SessionDetail } from '../types/agent'
import { Badge, Button, MathText } from '../ui'
import type { BadgeTone } from '../ui'

interface Props {
    detail: SessionDetail
    onBack: () => void
}

export function HistoricalSessionView({ detail, onBack }: Props) {
    const { session, quality, messages, tool_calls, artifacts, feedback } = detail
    const deliveryPassed = session.status === 'done' && quality?.quality_gate_passed === true

    // 重试会按时间追加产物。永远展示最终通过门禁的那次渲染，而不是第一次失败的尝试。
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
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <Button variant="ghost" size="sm" onClick={onBack} className="inline-flex items-center gap-1.5">
                    <ArrowLeft size={14} /> 返回新问题
                </Button>
                <span className="text-xs text-ink-faint">
                    会话 <span className="numeric">{session.id.slice(0, 8)}</span>
                </span>
            </div>

            <div className="plate p-5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint mb-2">
                    <span>{session.grade}</span>
                    <span>·</span>
                    <span className="numeric">{new Date(session.created_at).toLocaleString()}</span>
                    <StatusBadge status={session.status} />
                </div>
                <p className="stem">
                    <MathText>{session.problem}</MathText>
                </p>
                {session.error && (
                    <p className="mt-3 px-3 py-2 rounded-[10px] bg-wrong-wash border border-wrong/20 text-xs text-wrong">
                        {session.error}
                    </p>
                )}
            </div>

            {quality && (
                <div className="plate p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                        <p className="eyebrow">成片质量报告</p>
                        <Badge tone={quality.quality_gate_passed ? 'correct' : 'slate'}>
                            {quality.overall_quality} · B <span className="numeric">{quality.b_total ?? '—'}/12</span>
                        </Badge>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
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

            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                <div className={`plate p-3 ${manimArtifact ? 'md:col-span-8' : 'md:col-span-12'}`}>
                    {videoUrl ? (
                        <video src={videoUrl} controls className="w-full rounded-[10px] bg-ink">
                            {subtitleUrl && (
                                <track kind="captions" src={subtitleUrl} srcLang="zh" label="中文讲解" />
                            )}
                        </video>
                    ) : (
                        <p className="py-14 text-center text-sm text-ink-faint">
                            {session.status === 'done'
                                ? '视频未通过质量门禁，候选未交付'
                                : '任务未完成，候选视频不作为成品展示'}
                        </p>
                    )}
                </div>
                {manimArtifact && (
                    <div className="plate p-4 md:col-span-4 min-w-0">
                        <p className="eyebrow mb-2">代码归档路径</p>
                        <p className="text-xs text-ink-soft break-all font-mono">{manimArtifact.path}</p>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="plate p-5">
                    <p className="eyebrow mb-3">
                        工具调用 <span className="numeric">{tool_calls.length}</span>
                    </p>
                    {tool_calls.length === 0 ? (
                        <p className="text-xs text-ink-faint">无</p>
                    ) : (
                        <ul className="space-y-1.5 text-xs">
                            {tool_calls.map((tc) => (
                                <li
                                    key={tc.id}
                                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-[10px] border border-rule bg-paper"
                                >
                                    <span
                                        className={`w-2 h-2 rounded-full shrink-0 ${tc.status === 'success'
                                            ? 'bg-[color:var(--color-correct)]'
                                            : tc.status === 'failed'
                                                ? 'bg-wrong'
                                                : 'bg-rule'
                                            }`}
                                    />
                                    <code className="font-mono text-ink-soft truncate">{tc.name}</code>
                                    {tc.duration_ms != null && (
                                        <span className="numeric text-ink-faint ml-auto shrink-0">{tc.duration_ms} ms</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="plate p-5">
                    <p className="eyebrow mb-3">
                        对话消息 <span className="numeric">{messages.length}</span>
                    </p>
                    <ul className="space-y-1.5 text-xs max-h-60 overflow-auto">
                        {messages.map((m) => (
                            <li key={m.id} className="flex items-start gap-2">
                                <span
                                    className={`mt-1 inline-block w-2 h-2 rounded-full shrink-0 ${m.role === 'user' ? 'bg-beam' : m.role === 'assistant' ? 'bg-ink-faint' : 'bg-rule'
                                        }`}
                                />
                                <span className="font-mono text-ink-faint w-10 shrink-0">{m.role}</span>
                                <span className="text-ink-soft line-clamp-2 flex-1">{m.content || '(空)'}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>

            {feedback.length > 0 && (
                <div className="plate p-5">
                    <p className="eyebrow mb-3">反馈记录</p>
                    <ul className="space-y-2">
                        {feedback.map((f) => (
                            <li key={f.id} className="flex items-start gap-3 p-2.5 rounded-[10px] border border-rule bg-paper">
                                <span
                                    className={`inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0 ${f.label === 'good'
                                        ? 'bg-correct-wash text-correct'
                                        : f.label === 'bad'
                                            ? 'bg-wrong-wash text-wrong'
                                            : 'bg-plate text-ink-faint border border-rule'
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
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm text-ink">{f.notes || '（无备注）'}</p>
                                    <p className="numeric text-[11px] text-ink-faint mt-0.5">
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
        <div className="rounded-[10px] border border-rule bg-paper px-3 py-2">
            <p className="eyebrow mb-1">{label}</p>
            <p className="numeric text-sm font-semibold text-ink">{value}</p>
        </div>
    )
}

const SESSION_TONE: Record<string, BadgeTone> = {
    done: 'correct',
    failed: 'wrong',
    running: 'beam',
}

function StatusBadge({ status }: { status: string }) {
    return <Badge tone={SESSION_TONE[status] ?? 'slate'}>{status}</Badge>
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
