/**
 * AgentTimeline — 按时间顺序展示流式返回的推理、工具调用与消息。
 * 视觉：每条工具调用是一张 .plate 图版；阶段不用彩虹色，只用 beam/right/wrong/中性。
 */
import { useState } from 'react'
import {
    Brain,
    ChevronDown,
    ChevronRight,
    CheckCircle2,
    CircleAlert,
    XCircle,
    Wrench,
    FileCode2,
    Sparkles,
    Loader2,
} from 'lucide-react'

import type { TimelineItem, AgentRunState } from '../types/agent'
import { Badge } from '../ui'
import type { BadgeTone } from '../ui'

interface AgentTimelineProps {
    state: AgentRunState
}

export function AgentTimeline({ state }: AgentTimelineProps) {
    if (state.items.length === 0 && state.status === 'idle') {
        return null
    }

    return (
        <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <span className="eyebrow">Agent 思考过程</span>
                <StatusBadge status={state.status} />
            </div>

            <div className="space-y-2.5">
                {state.items.map((item) => (
                    <TimelineEntry key={item.key} item={item} />
                ))}
                {state.status === 'running' && state.items.length === 0 && (
                    <p className="flex items-center gap-2 text-sm text-ink-faint">
                        <Loader2 className="animate-spin" size={14} /> 正在连接 LLM……
                    </p>
                )}
                {state.error && (
                    <div className="plate border-l-[3px] border-l-wrong px-4 py-3 text-sm text-wrong">
                        {state.error}
                    </div>
                )}
            </div>
        </section>
    )
}

const STATUS_BADGE: Record<AgentRunState['status'], { label: string; tone: BadgeTone }> = {
    idle: { label: '待命', tone: 'slate' },
    running: { label: '推理中', tone: 'beam' },
    done: { label: '已完成', tone: 'correct' },
    exhausted: { label: '轮数耗尽', tone: 'slate' },
    failed: { label: '失败', tone: 'wrong' },
}

function StatusBadge({ status }: { status: AgentRunState['status'] }) {
    const info = STATUS_BADGE[status]
    return <Badge tone={info.tone}>{info.label}</Badge>
}

function TimelineEntry({ item }: { item: TimelineItem }) {
    if (item.kind === 'message') {
        if (!item.text.trim()) return null
        return (
            <div className="rounded-[10px] border border-rule bg-paper px-4 py-3 text-sm leading-relaxed text-ink-soft whitespace-pre-wrap">
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
        <div className="rounded-[10px] border border-rule bg-paper">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-ink-soft hover:text-beam"
            >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Brain size={14} />
                思考过程（<span className="numeric">{text.length}</span> 字）
            </button>
            {open && (
                <pre className="px-4 pb-3 text-[11px] leading-relaxed text-ink-soft whitespace-pre-wrap font-mono max-h-72 overflow-auto">
                    {text}
                </pre>
            )}
        </div>
    )
}

function ToolStatus({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
    const duration =
        item.durationMs != null ? (
            <span className="numeric text-ink-faint">· {item.durationMs} ms</span>
        ) : null

    switch (item.status) {
        case 'running':
            return (
                <span className="inline-flex items-center gap-1 text-xs text-beam">
                    <Loader2 size={12} className="animate-spin" /> 执行中
                </span>
            )
        case 'success':
            return (
                <span className="inline-flex items-center gap-1 text-xs text-correct">
                    <CheckCircle2 size={12} /> 成功 {duration}
                </span>
            )
        case 'failed':
            return (
                <span className="inline-flex items-center gap-1 text-xs text-wrong">
                    <XCircle size={12} /> 失败 {duration}
                </span>
            )
        case 'revision':
            return (
                <span className="inline-flex items-center gap-1 text-xs text-ink-soft">
                    <CircleAlert size={12} /> 需修正 {duration}
                </span>
            )
    }
}

function ToolCard({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
    const [open, setOpen] = useState(false)

    return (
        <div className="plate overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-paper transition-colors"
            >
                {open ? (
                    <ChevronDown size={14} className="text-ink-faint shrink-0" />
                ) : (
                    <ChevronRight size={14} className="text-ink-faint shrink-0" />
                )}
                <span className="inline-flex items-center justify-center w-7 h-7 rounded-[8px] border border-rule bg-paper text-ink-faint shrink-0">
                    {toolIcon(item.name)}
                </span>
                <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <code className="text-sm font-mono font-semibold text-ink">{toolLabel(item.name)}</code>
                        <ToolStatus item={item} />
                    </div>
                    {item.summary && <div className="text-xs text-ink-faint mt-0.5 truncate">{item.summary}</div>}
                </div>
            </button>

            {open && (
                <div className="border-t border-rule px-3 py-3 space-y-3 text-xs">
                    <div>
                        <p className="eyebrow mb-1">参数</p>
                        <pre className="bg-paper border border-rule rounded-[10px] p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-ink-soft">
                            {JSON.stringify(item.arguments, null, 2)}
                        </pre>
                    </div>

                    {item.error && (
                        <div>
                            <p className="eyebrow mb-1 text-wrong">错误</p>
                            <pre className="bg-wrong-wash border border-wrong/20 rounded-[10px] p-2 text-wrong max-h-32 overflow-auto whitespace-pre-wrap">
                                {item.error}
                            </pre>
                        </div>
                    )}

                    {item.data && (
                        <div>
                            <p className="eyebrow mb-1">结果</p>
                            <pre className="bg-paper border border-rule rounded-[10px] p-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-ink-soft">
                                {JSON.stringify(item.data, null, 2)}
                            </pre>
                        </div>
                    )}

                    {item.artifacts.length > 0 && (
                        <div>
                            <p className="eyebrow mb-1">产出</p>
                            <ul className="text-ink-soft space-y-1">
                                {item.artifacts.map((a) => (
                                    <li key={`${a.kind}-${a.id}`} className="flex items-center gap-2">
                                        <FileCode2 size={12} className="text-ink-faint shrink-0" />
                                        <span className="font-mono">{a.kind}</span>
                                        <span className="text-ink-faint">→</span>
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

function toolLabel(name: string): string {
    const labels: Record<string, string> = {
        solve_problem: 'Solve · 理解与求解',
        verify_solution: 'Verify · 独立验算',
        direct_video: 'Direct · 视觉导演',
        compile_video: 'Compile · 编译成片',
        watch_video: 'Watch · 成片审查',
    }
    return labels[name] || name
}

/** 图标只区分「做什么」，颜色一律中性——状态由 Badge / ToolStatus 表达 */
function toolIcon(name: string): React.ReactNode {
    switch (name) {
        case 'solve_problem':
        case 'verify_solution':
            return <Brain size={14} />
        case 'match_skill':
        case 'direct_video':
            return <Sparkles size={14} />
        case 'search_examples':
        case 'generate_manim_code':
        case 'compile_video':
        case 'validate_manim_code':
            return <FileCode2 size={14} />
        default:
            return <Wrench size={14} />
    }
}
