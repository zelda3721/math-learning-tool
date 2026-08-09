// 覆盖度面板（P1b）：GET /api/v1/knowledge/coverage 渲染
//  - 顶部四格统计（节点总数 / 已覆盖 / 已核验 / 题目总数）
//  - 核验候选 TOP：命中题数条形 + 「标记已核验」→ POST /knowledge/verify-node
//  - 图谱缺口（折叠）：uncoveredByStage 按学段分组 chips，点击派发
//    mathtutor:atlas-focus 事件让星图选中该节点
import { useCallback, useEffect, useRef, useState } from 'react'

// ── 与 server knowledgeAdmin.ts 输出对齐的本地类型（server 未经 schema 包导出） ──
export interface CoverageRow {
    nodeId: string
    name: string
    stage: string
    strand: string
    status: string
    questionCount: number
    verifiedQuestionCount: number
}

export interface CoverageReport {
    nodes: CoverageRow[]
    uncoveredByStage: Record<string, string[]>
    topUnverified: CoverageRow[]
    totals: { nodes: number; covered: number; verifiedNodes: number; questions: number }
}

/** 节点核验：成功返回 ok:true；422 等失败时带回 error 文案 */
export async function verifyNodeApi(
    nodeId: string,
    sourceTitle = '家长人工核验'
): Promise<{ ok: boolean; error?: string }> {
    try {
        const res = await fetch('/api/v1/knowledge/verify-node', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId, source: { title: sourceTitle } }),
        })
        if (res.ok) return { ok: true }
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        return { ok: false, error: body?.error ?? `HTTP ${res.status}` }
    } catch {
        return { ok: false, error: '网络错误' }
    }
}

/** 覆盖度数据源：AtlasPage 与面板共用（NodeDetail 命中题数也从这里来） */
export function useCoverage(): {
    report: CoverageReport | null
    failed: boolean
    reload: () => void
} {
    const [report, setReport] = useState<CoverageReport | null>(null)
    const [failed, setFailed] = useState(false)
    const alive = useRef(true)
    useEffect(() => {
        alive.current = true
        return () => {
            alive.current = false
        }
    }, [])
    const reload = useCallback(() => {
        fetch('/api/v1/knowledge/coverage')
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                return res.json() as Promise<CoverageReport>
            })
            .then((data) => {
                if (!alive.current) return
                setReport(data)
                setFailed(false)
            })
            .catch(() => {
                if (alive.current) setFailed(true)
            })
    }, [])
    useEffect(() => {
        reload()
    }, [reload])
    return { report, failed, reload }
}

const STAGE_FALLBACK: Record<string, string> = {
    primary: '小学',
    junior: '初中',
    senior: '高中',
    university: '大学·前沿',
}

interface CoveragePanelProps {
    report: CoverageReport | null
    failed: boolean
    onReload: () => void
    /** 学段 id → 展示名（AtlasPage 从 graph 传入；缺省用内置映射） */
    stageNames?: Record<string, string>
    /** 某节点被成功核验后回调（AtlasPage 用于同步 NodeDetail 徽章） */
    onVerified?: (nodeId: string) => void
}

function StatCell({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-xl bg-slate-50 border border-slate-100 px-2 py-1.5 text-center">
            <div className="text-lg font-extrabold text-slate-800 leading-tight">{value}</div>
            <div className="text-[11px] text-slate-400">{label}</div>
        </div>
    )
}

export function CoveragePanel({ report, failed, onReload, stageNames, onVerified }: CoveragePanelProps) {
    const [busyId, setBusyId] = useState<string | null>(null)
    const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
    const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        return () => {
            if (noticeTimer.current) clearTimeout(noticeTimer.current)
        }
    }, [])

    const flash = (kind: 'ok' | 'err', text: string) => {
        setNotice({ kind, text })
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(null), 4000)
    }

    const verify = async (row: CoverageRow) => {
        setBusyId(row.nodeId)
        const res = await verifyNodeApi(row.nodeId)
        setBusyId(null)
        if (res.ok) {
            flash('ok', `已核验：${row.name}`)
            onVerified?.(row.nodeId)
            onReload()
        } else {
            flash('err', `核验失败：${res.error ?? '未知错误'}`)
        }
    }

    const focusNode = (nodeId: string) => {
        window.dispatchEvent(new CustomEvent('mathtutor:atlas-focus', { detail: { nodeId } }))
    }

    if (failed && !report) {
        return (
            <div className="p-4 text-sm text-slate-400">
                覆盖度数据加载失败
                <button
                    type="button"
                    onClick={onReload}
                    className="ml-2 text-indigo-500 hover:text-indigo-600 font-semibold"
                >
                    重试
                </button>
            </div>
        )
    }
    if (!report) {
        return <div className="p-4 text-sm text-slate-400">覆盖度加载中…</div>
    }

    const nameOf = new Map(report.nodes.map((r) => [r.nodeId, r.name]))
    const stageLabel = (id: string) => stageNames?.[id] ?? STAGE_FALLBACK[id] ?? id
    const maxHits = Math.max(1, ...report.topUnverified.map((r) => r.questionCount))
    const stageEntries = Object.entries(report.uncoveredByStage).filter(([, ids]) => ids.length > 0)

    return (
        <div className="p-4 space-y-4">
            <div className="grid grid-cols-4 gap-1.5">
                <StatCell label="节点总数" value={report.totals.nodes} />
                <StatCell label="已覆盖" value={report.totals.covered} />
                <StatCell label="已核验" value={report.totals.verifiedNodes} />
                <StatCell label="题目总数" value={report.totals.questions} />
            </div>

            {notice && (
                <div
                    role="status"
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                        notice.kind === 'ok'
                            ? 'bg-emerald-50 text-emerald-600'
                            : 'bg-red-50 text-red-500'
                    }`}
                >
                    {notice.text}
                </div>
            )}

            <section>
                <h3 className="text-xs font-extrabold tracking-wide text-slate-600 mb-2">
                    核验候选 TOP
                </h3>
                {report.topUnverified.length === 0 ? (
                    <p className="text-xs text-slate-400">暂无待核验节点</p>
                ) : (
                    <ul className="space-y-1.5">
                        {report.topUnverified.map((row) => (
                            <li key={row.nodeId} className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => focusNode(row.nodeId)}
                                    title="在星图中查看"
                                    className="w-[110px] shrink-0 truncate text-left text-xs font-semibold text-slate-700 hover:text-indigo-600"
                                >
                                    {row.name}
                                </button>
                                <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                                    <div
                                        className="h-full rounded-full bg-amber-400"
                                        style={{ width: `${Math.max(6, (row.questionCount / maxHits) * 100)}%` }}
                                    />
                                </div>
                                <span className="w-6 text-right text-[11px] tabular-nums text-slate-400">
                                    {row.questionCount}
                                </span>
                                <button
                                    type="button"
                                    disabled={busyId === row.nodeId}
                                    onClick={() => verify(row)}
                                    className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-600 hover:bg-emerald-100 disabled:opacity-50 transition-colors"
                                >
                                    {busyId === row.nodeId ? '提交中…' : '标记已核验'}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <details>
                <summary className="cursor-pointer text-xs font-extrabold tracking-wide text-slate-600 select-none">
                    图谱缺口（{stageEntries.reduce((n, [, ids]) => n + ids.length, 0)} 个节点无题目）
                </summary>
                <div className="mt-2 space-y-2.5">
                    {stageEntries.length === 0 && (
                        <p className="text-xs text-slate-400">所有节点均已有题目覆盖</p>
                    )}
                    {stageEntries.map(([stage, ids]) => (
                        <div key={stage}>
                            <div className="text-[11px] font-bold text-slate-400 mb-1">
                                {stageLabel(stage)}
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {ids.map((id) => (
                                    <button
                                        type="button"
                                        key={id}
                                        onClick={() => focusNode(id)}
                                        title="在星图中定位"
                                        className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                                    >
                                        {nameOf.get(id) ?? id}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </details>
        </div>
    )
}
