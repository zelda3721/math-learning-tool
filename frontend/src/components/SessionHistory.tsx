/**
 * SessionHistory — drawer-style sidebar listing past chat sessions.
 *
 * Lets the user filter by feedback label and reopen any session as a
 * read-only view (caller decides what to do on selection).
 */
import { useEffect, useMemo, useState } from 'react'
import { History, X, Filter, RefreshCw, ThumbsUp, ThumbsDown } from 'lucide-react'

import { api } from '../services/api'
import type { PersistedSession } from '../types/agent'

interface SessionHistoryProps {
    open: boolean
    onClose: () => void
    onSelect: (session: PersistedSession) => void
    refreshKey?: number
}

type FilterLabel = 'all' | 'good' | 'bad'

const FILTER_OPTIONS: Array<{ value: FilterLabel; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'good', label: '👍 好的' },
    { value: 'bad', label: '👎 差的' },
]

export function SessionHistory({ open, onClose, onSelect, refreshKey }: SessionHistoryProps) {
    const [filter, setFilter] = useState<FilterLabel>('all')
    const [sessions, setSessions] = useState<PersistedSession[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

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
    }, [open, filter, refreshKey])

    const grouped = useMemo(() => groupByDate(sessions), [sessions])

    return (
        <>
            {/* Backdrop */}
            {open && (
                <div
                    className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-40"
                    onClick={onClose}
                    aria-hidden
                />
            )}

            <aside
                className={`fixed top-0 right-0 h-full w-full sm:w-[420px] z-50 transform transition-transform duration-300 ease-out
                            bg-white shadow-2xl ${open ? 'translate-x-0' : 'translate-x-full'}`}
            >
                <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
                    <div className="flex items-center gap-2 text-slate-700">
                        <History size={18} />
                        <h2 className="font-bold">历史会话</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-700 transition"
                        aria-label="关闭"
                    >
                        <X size={20} />
                    </button>
                </header>

                <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2 text-xs">
                    <Filter size={14} className="text-slate-400" />
                    <div className="flex gap-1">
                        {FILTER_OPTIONS.map((opt) => (
                            <button
                                key={opt.value}
                                onClick={() => setFilter(opt.value)}
                                className={`px-2 py-1 rounded-full transition ${filter === opt.value
                                    ? 'bg-sky-500 text-white'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                    }`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                    <button
                        onClick={() => setFilter((f) => f)}
                        className="ml-auto text-slate-400 hover:text-slate-700"
                        aria-label="刷新"
                    >
                        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>

                <div className="overflow-y-auto h-[calc(100%-110px)] px-3 py-2 space-y-4">
                    {loading && sessions.length === 0 && (
                        <div className="text-center text-slate-400 text-sm py-8">加载中...</div>
                    )}
                    {error && (
                        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                            {error}
                        </div>
                    )}
                    {!loading && sessions.length === 0 && !error && (
                        <div className="text-center text-slate-400 text-sm py-8">暂无历史</div>
                    )}
                    {grouped.map(({ date, items }) => (
                        <section key={date}>
                            <h3 className="text-[11px] uppercase font-bold text-slate-400 mb-2 px-2">
                                {date}
                            </h3>
                            <ul className="space-y-1.5">
                                {items.map((s) => (
                                    <li key={s.id}>
                                        <button
                                            onClick={() => onSelect(s)}
                                            className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 border border-transparent hover:border-slate-200 transition group"
                                        >
                                            <div className="flex items-start gap-2">
                                                <SessionStatusBadge status={s.status} />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm text-slate-700 line-clamp-2">
                                                        {s.problem}
                                                    </p>
                                                    <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                                                        <span>{s.grade}</span>
                                                        <span>·</span>
                                                        <span>{formatTime(s.created_at)}</span>
                                                    </div>
                                                </div>
                                            </div>
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

function SessionStatusBadge({ status }: { status: string }) {
    let dot = 'bg-slate-300'
    let icon: React.ReactNode = null
    if (status === 'done') {
        dot = 'bg-emerald-400'
        icon = <ThumbsUp size={10} className="text-emerald-700" />
    } else if (status === 'running') {
        dot = 'bg-blue-400 animate-pulse'
    } else if (status === 'failed') {
        dot = 'bg-red-400'
        icon = <ThumbsDown size={10} className="text-red-700" />
    }
    return (
        <span className={`mt-1 inline-flex items-center justify-center w-3 h-3 rounded-full ${dot}`}>
            {icon}
        </span>
    )
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
