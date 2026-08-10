/**
 * SessionHistory — 右侧抽屉，列出历史会话。
 *
 * 支持按反馈标签过滤，点击任一条以只读方式重新打开（由调用方决定后续动作）。
 */
import { useEffect, useMemo, useState } from 'react'
import { X, RefreshCw, Trash2 } from 'lucide-react'

import { api } from '../services/api'
import type { PersistedSession } from '../types/agent'
import { LoadingState } from '../ui'

interface SessionHistoryProps {
    open: boolean
    onClose: () => void
    onSelect: (session: PersistedSession) => void
    refreshKey?: number
}

type FilterLabel = 'all' | 'good' | 'bad'

const FILTER_OPTIONS: Array<{ value: FilterLabel; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'good', label: '好的' },
    { value: 'bad', label: '差的' },
]

export function SessionHistory({ open, onClose, onSelect, refreshKey }: SessionHistoryProps) {
    const [filter, setFilter] = useState<FilterLabel>('all')
    const [sessions, setSessions] = useState<PersistedSession[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [deleting, setDeleting] = useState<string | null>(null)
    const [refreshNonce, setRefreshNonce] = useState(0)

    async function handleDelete(s: PersistedSession, e: React.MouseEvent) {
        e.stopPropagation()
        if (deleting) return
        const confirmed = window.confirm(
            `确认删除会话？\n\n"${s.problem.slice(0, 60)}${s.problem.length > 60 ? '...' : ''}"\n\n` +
            `这会一起删除：\n· 对话记录与工具调用日志\n· 生成的代码和视频文件\n\n此操作不可恢复。`,
        )
        if (!confirmed) return
        setDeleting(s.id)
        try {
            await api.deleteSession(s.id)
            setSessions((cur) => cur.filter((x) => x.id !== s.id))
        } catch (err) {
            window.alert(`删除失败：${err instanceof Error ? err.message : String(err)}`)
        } finally {
            setDeleting(null)
        }
    }

    useEffect(() => {
        if (!open) return
        let cancelled = false
        setLoading(true)
        setError(null)
        const params = filter === 'all' ? {} : { label: filter }
        api.listSessions({ ...params, limit: 100 })
            .then((data) => {
                if (!cancelled) setSessions(data)
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err))
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [open, filter, refreshKey, refreshNonce])

    const grouped = useMemo(() => groupByDate(sessions), [sessions])

    return (
        <>
            {open && (
                <div className="fixed inset-0 bg-ink/25 z-40" onClick={onClose} aria-hidden />
            )}

            <aside
                className={`fixed top-0 right-0 h-full w-full sm:w-[420px] z-50 flex flex-col
                            bg-plate border-l border-rule transform transition-transform duration-300 ease-out
                            ${open ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <header className="px-5 py-4 border-b border-rule flex items-center justify-between shrink-0">
                    <h2 className="text-lg font-bold text-ink tracking-tight">历史会话</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1.5 rounded-[10px] text-ink-faint hover:text-ink hover:bg-paper transition-colors"
                        aria-label="关闭"
                    >
                        <X size={18} />
                    </button>
                </header>

                <div className="px-5 py-3 border-b border-rule flex items-center gap-1.5 shrink-0">
                    {FILTER_OPTIONS.map((opt) => (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => setFilter(opt.value)}
                            className={`px-3 py-1 rounded-[10px] border text-xs font-medium transition-colors ${
                                filter === opt.value
                                    ? 'border-beam bg-beam-wash text-beam'
                                    : 'border-rule bg-plate text-ink-faint hover:text-ink'
                            }`}
                        >
                            {opt.label}
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={() => setRefreshNonce((value) => value + 1)}
                        className="ml-auto p-1.5 rounded-[10px] text-ink-faint hover:text-beam hover:bg-paper transition-colors"
                        aria-label="刷新"
                    >
                        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
                    {loading && sessions.length === 0 && <LoadingState text="正在读取历史……" />}
                    {error && (
                        <p className="mx-2 px-3 py-2 rounded-[10px] bg-wrong-wash border border-wrong/20 text-xs text-wrong">
                            {error}
                        </p>
                    )}
                    {!loading && sessions.length === 0 && !error && (
                        <p className="py-12 text-center text-sm text-ink-faint">暂无历史会话</p>
                    )}

                    {grouped.map(({ date, items }) => (
                        <section key={date}>
                            <h3 className="eyebrow numeric px-2 mb-2">{date}</h3>
                            <ul className="space-y-1.5">
                                {items.map((s) => (
                                    <li key={s.id} className="group/row relative">
                                        <button
                                            type="button"
                                            onClick={() => onSelect(s)}
                                            className="w-full text-left pl-3 pr-10 py-2.5 rounded-[10px] border border-transparent
                                                       hover:bg-paper hover:border-rule transition-colors"
                                        >
                                            <div className="flex items-start gap-2">
                                                <SessionStatusDot status={s.status} />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm text-ink line-clamp-2">{s.problem}</p>
                                                    <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-faint">
                                                        <span>{s.grade}</span>
                                                        <span>·</span>
                                                        <span className="numeric">{formatTime(s.created_at)}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={(e) => handleDelete(s, e)}
                                            disabled={deleting === s.id}
                                            className="absolute top-2 right-2 p-1.5 rounded-[8px] text-ink-faint hover:text-wrong hover:bg-wrong-wash
                                                       opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 transition
                                                       disabled:opacity-50 disabled:cursor-not-allowed"
                                            aria-label="删除会话"
                                            title="删除会话"
                                        >
                                            {deleting === s.id ? (
                                                <RefreshCw size={14} className="animate-spin" />
                                            ) : (
                                                <Trash2 size={14} />
                                            )}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            </aside>
        </>
    )
}

function SessionStatusDot({ status }: { status: string }) {
    const cls =
        status === 'done'
            ? 'bg-[color:var(--color-correct)]'
            : status === 'running'
                ? 'bg-beam animate-pulse'
                : status === 'failed'
                    ? 'bg-wrong'
                    : 'bg-rule'
    return <span className={`mt-1.5 shrink-0 w-2 h-2 rounded-full ${cls}`} aria-label={status} />
}

interface DateGroup {
    date: string
    items: PersistedSession[]
}

function groupByDate(sessions: PersistedSession[]): DateGroup[] {
    const map = new Map<string, PersistedSession[]>()
    for (const s of sessions) {
        const date = s.created_at.slice(0, 10)
        const arr = map.get(date) || []
        arr.push(s)
        map.set(date, arr)
    }
    return Array.from(map.entries())
        .sort((a, b) => (a[0] > b[0] ? -1 : 1))
        .map(([date, items]) => ({ date, items }))
}

function formatTime(iso: string): string {
    try {
        const d = new Date(iso)
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
        return iso
    }
}
