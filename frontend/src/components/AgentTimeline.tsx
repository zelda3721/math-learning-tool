/**
 * AgentTimeline — renders the streamed agent reasoning, tool calls, and
 * messages in chronological order.
 */
import { useState } from 'react'
import {
    Brain,
    ChevronDown,
    ChevronRight,
    Loader2,
    CheckCircle2,
    XCircle,
    Wrench,
    FileCode2,
    Sparkles,
} from 'lucide-react'

import type { TimelineItem, AgentRunState } from '../types/agent'

interface AgentTimelineProps {
    state: AgentRunState
}

export function AgentTimeline({ state }: AgentTimelineProps) {
    if (state.items.length === 0 && state.status === 'idle') {
        return null
    }

    return (
        <div className="bento-card md:col-span-12 bg-white/70">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 text-violet-600">
                    <Sparkles size={20} />
                    <h3 className="font-bold">Agent 思考过程</h3>
                </div>
                <StatusBadge status={state.status} />
            </div>

            <div className="space-y-3">
                {state.items.map((item) => (
                    <TimelineEntry key={item.key} item={item} />
                ))}
                {state.status === 'running' && state.items.length === 0 && (
                    <div className="text-slate-400 text-sm italic flex items-center gap-2">
                        <Loader2 className="animate-spin" size={14} /> 正在连接 LLM...
                    </div>
                )}
                {state.error && (
                    <div className="border-l-4 border-red-400 bg-red-50/60 px-3 py-2 rounded-md text-sm text-red-700">
                        {state.error}
                    </div>
                )}
            </div>
        </div>
    )
}

function StatusBadge({ status }: { status: AgentRunState['status'] }) {
    const map: Record<AgentRunState['status'], { label: string; cls: string; icon: React.ReactNode }> = {
        idle: { label: '待命', cls: 'bg-slate-100 text-slate-500', icon: null },
        running: {
            label: '推理中',
            cls: 'bg-blue-100 text-blue-700',
            icon: <Loader2 size={12} className="animate-spin" />,
        },
        done: {
            label: '已完成',
            cls: 'bg-emerald-100 text-emerald-700',
            icon: <CheckCircle2 size={12} />,
        },
        exhausted: {
            label: '轮数耗尽',
            cls: 'bg-amber-100 text-amber-700',
            icon: <XCircle size={12} />,
        },
        failed: {
            label: '失败',
            cls: 'bg-red-100 text-red-700',
            icon: <XCircle size={12} />,
        },
    }
    const info = map[status]
    return (
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full font-medium ${info.cls}`}>
            {info.icon}
            {info.label}
        </span>
    )
}

function TimelineEntry({ item }: { item: TimelineItem }) {
    if (item.kind === 'message') {
        if (!item.text.trim()) return null
        return (
            <div className="px-4 py-3 rounded-xl bg-slate-50/80 border border-slate-200/60 text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">
                {item.text}
            </div>
        )
    }
    if (item.kind === 'reasoning') {
        return <ReasoningBlock text={item.text} />
    }
    return <ToolCard item={item} />
}

function ReasoningBlock({ text }: { text: string }) {
    const [open, setOpen] = useState(false)
    if (!text.trim()) return null
    return (
        <div className="rounded-xl border border-violet-200 bg-violet-50/50">
            <button
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 text-violet-700 text-xs font-medium hover:bg-violet-100/40 rounded-xl"
            >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Brain size={14} />
                思考过程（{text.length} 字）
            </button>
            {open && (
                <pre className="px-4 pb-3 text-[11px] leading-relaxed text-violet-900 whitespace-pre-wrap font-mono max-h-72 overflow-auto">
                    {text}
                </pre>
            )}
        </div>
    )
}

function ToolCard({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
    const [open, setOpen] = useState(false)
    const palette = toolPalette(item.name)
    const statusBadge = (() => {
        switch (item.status) {
            case 'running':
                return (
                    <span className="inline-flex items-center gap-1 text-xs text-blue-700">
                        <Loader2 size={12} className="animate-spin" /> 执行中
                    </span>
                )
            case 'success':
                return (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                        <CheckCircle2 size={12} /> 成功
                        {item.durationMs != null && (
                            <span className="text-slate-400">· {item.durationMs} ms</span>
                        )}
                    </span>
                )
            case 'failed':
                return (
                    <span className="inline-flex items-center gap-1 text-xs text-red-700">
                        <XCircle size={12} /> 失败
                        {item.durationMs != null && (
                            <span className="text-slate-400">· {item.durationMs} ms</span>
                        )}
                    </span>
                )
        }
    })()

    return (
        <div className={`rounded-xl border ${palette.border} ${palette.bg} overflow-hidden`}>
            <button
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-white/40"
            >
                {open ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
                <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg ${palette.iconBg} ${palette.iconColor}`}>
                    {palette.icon}
                </span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <code className="text-sm font-mono font-semibold text-slate-700">
                            {item.name}
                        </code>
                        {statusBadge}
                    </div>
                    {item.summary && (
                        <div className="text-xs text-slate-500 mt-0.5 truncate">{item.summary}</div>
                    )}
                </div>
            </button>

            {open && (
                <div className="border-t border-white/60 bg-white/60 px-3 py-3 space-y-3 text-xs">
                    <div>
                        <div className="text-slate-500 font-semibold mb-1">参数</div>
                        <pre className="bg-slate-50 border border-slate-200 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-slate-700">
                            {JSON.stringify(item.arguments, null, 2)}
                        </pre>
                    </div>

                    {item.error && (
                        <div>
                            <div className="text-red-500 font-semibold mb-1">错误</div>
                            <pre className="bg-red-50 border border-red-200 rounded p-2 text-red-700 max-h-32 overflow-auto whitespace-pre-wrap">
                                {item.error}
                            </pre>
                        </div>
                    )}

                    {item.data && (
                        <div>
                            <div className="text-slate-500 font-semibold mb-1">结果</div>
                            <pre className="bg-slate-50 border border-slate-200 rounded p-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-slate-700">
                                {JSON.stringify(item.data, null, 2)}
                            </pre>
                        </div>
                    )}

                    {item.artifacts.length > 0 && (
                        <div>
                            <div className="text-slate-500 font-semibold mb-1">产出</div>
                            <ul className="text-slate-600 space-y-1">
                                {item.artifacts.map((a) => (
                                    <li key={`${a.kind}-${a.id}`} className="flex items-center gap-2">
                                        <FileCode2 size={12} className="text-slate-400" />
                                        <span className="font-mono">{a.kind}</span>
                                        <span className="text-slate-400">→</span>
                                        <span className="truncate">{a.path}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

function toolPalette(name: string): {
    bg: string
    border: string
    iconBg: string
    iconColor: string
    icon: React.ReactNode
} {
    switch (name) {
        case 'analyze_problem':
            return {
                bg: 'bg-indigo-50/40',
                border: 'border-indigo-200',
                iconBg: 'bg-indigo-100',
                iconColor: 'text-indigo-600',
                icon: <Brain size={14} />,
            }
        case 'match_skill':
            return {
                bg: 'bg-sky-50/40',
                border: 'border-sky-200',
                iconBg: 'bg-sky-100',
                iconColor: 'text-sky-600',
                icon: <Sparkles size={14} />,
            }
        case 'search_examples':
            return {
                bg: 'bg-amber-50/40',
                border: 'border-amber-200',
                iconBg: 'bg-amber-100',
                iconColor: 'text-amber-600',
                icon: <FileCode2 size={14} />,
            }
        case 'generate_manim_code':
            return {
                bg: 'bg-violet-50/40',
                border: 'border-violet-200',
                iconBg: 'bg-violet-100',
                iconColor: 'text-violet-600',
                icon: <FileCode2 size={14} />,
            }
        case 'validate_manim_code':
            return {
                bg: 'bg-teal-50/40',
                border: 'border-teal-200',
                iconBg: 'bg-teal-100',
                iconColor: 'text-teal-600',
                icon: <CheckCircle2 size={14} />,
            }
        case 'run_manim':
            return {
                bg: 'bg-emerald-50/40',
                border: 'border-emerald-200',
                iconBg: 'bg-emerald-100',
                iconColor: 'text-emerald-600',
                icon: <Wrench size={14} />,
            }
        default:
            return {
                bg: 'bg-slate-50/60',
                border: 'border-slate-200',
                iconBg: 'bg-slate-100',
                iconColor: 'text-slate-500',
                icon: <Wrench size={14} />,
            }
    }
}
