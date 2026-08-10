/**
 * P1b 批量抽题面板：多文件（txt/md/pdf）+ 每文件 role → POST /api/v1/ingest/batch
 * → 1s 轮询 /api/v1/ingest/jobs/:id 展示进度 → done 后把 drafts 交回父组件复用草稿确认流程。
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Lightline } from '../ui'
import { dropzoneCls, extractErrorMessage, fileInputCls, normalizeDraft, readFileAsDataUrl } from './shared'
import type { Draft } from './shared'

type FileRole = 'teacher' | 'student' | 'auto'

const ROLE_LABELS: Record<FileRole, string> = {
    auto: '自动识别',
    teacher: '教师版（含答案）',
    student: '学生版',
}

const STAGE_LABELS: Record<string, string> = {
    extract: '抽取题目',
    pair: '配对答案',
    done: '完成',
}

export interface PairingReport {
    matched: number
    teacherOnly: number
    studentOnly: number
}

export interface BatchOutcome {
    drafts: Draft[]
    warnings: string[]
    pairing?: PairingReport
}

interface BatchFileEntry {
    id: number
    file: File
    role: FileRole
}

interface BatchPayloadFile {
    name: string
    kind: 'text' | 'pdf'
    content: string
    role: FileRole
}

interface JobProgress {
    stage: string
    current: number
    total: number
    file?: string
}

interface JobBody {
    status?: 'running' | 'done' | 'failed'
    progress?: JobProgress
    result?: {
        batchName?: string
        drafts?: unknown[]
        warnings?: unknown[]
        pairing?: Partial<PairingReport>
    }
    error?: string
}

let fileSeq = 0

function normalizePairing(raw: Partial<PairingReport> | undefined): PairingReport | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    return {
        matched: typeof raw.matched === 'number' ? raw.matched : 0,
        teacherOnly: typeof raw.teacherOnly === 'number' ? raw.teacherOnly : 0,
        studentOnly: typeof raw.studentOnly === 'number' ? raw.studentOnly : 0,
    }
}

export function BatchPanel({
    batchName,
    onDone,
}: {
    batchName: string
    onDone: (outcome: BatchOutcome) => void
}) {
    const [entries, setEntries] = useState<BatchFileEntry[]>([])
    const [jobId, setJobId] = useState<string | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const [progress, setProgress] = useState<JobProgress | null>(null)
    const [error, setError] = useState<string | null>(null)
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    /** failed 后重试用：上一次已读取完的请求体 */
    const lastPayloadRef = useRef<{ batchName: string; files: BatchPayloadFile[] } | null>(null)

    const addFiles = (list: FileList | null) => {
        if (!list) return
        const next = Array.from(list).map((file) => ({ id: ++fileSeq, file, role: 'auto' as FileRole }))
        setEntries((es) => [...es, ...next])
        if (fileInputRef.current) fileInputRef.current.value = ''
    }

    const postBatch = async (payload: { batchName: string; files: BatchPayloadFile[] }) => {
        setError(null)
        setProgress(null)
        setSubmitting(true)
        try {
            const res = await fetch('/api/v1/ingest/batch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
            })
            if (!res.ok) {
                setError(await extractErrorMessage(res, '服务端批量抽题流水线尚未就绪（需要配置 LLM）。'))
                return
            }
            const body = (await res.json()) as { jobId?: unknown }
            if (typeof body.jobId !== 'string' || !body.jobId) {
                setError('服务端未返回任务 ID，无法跟踪批量抽题进度。')
                return
            }
            setJobId(body.jobId)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSubmitting(false)
        }
    }

    const handleStart = async () => {
        setError(null)
        try {
            const files: BatchPayloadFile[] = []
            for (const e of entries) {
                const isPdf = /\.pdf$/i.test(e.file.name)
                files.push({
                    name: e.file.name,
                    kind: isPdf ? 'pdf' : 'text',
                    content: isPdf ? await readFileAsDataUrl(e.file) : await e.file.text(),
                    role: e.role,
                })
            }
            const payload = { batchName, files }
            lastPayloadRef.current = payload
            await postBatch(payload)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }

    const handleRetry = () => {
        if (lastPayloadRef.current) void postBatch(lastPayloadRef.current)
    }

    /* 1s 轮询任务状态；组件卸载或重新开始时取消 */
    useEffect(() => {
        if (!jobId) return
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | undefined

        const tick = async () => {
            try {
                const res = await fetch(`/api/v1/ingest/jobs/${encodeURIComponent(jobId)}`)
                if (cancelled) return
                if (!res.ok) {
                    setError(await extractErrorMessage(res, '批量任务查询失败。'))
                    setJobId(null)
                    return
                }
                const body = (await res.json()) as JobBody
                if (cancelled) return
                if (body.progress) setProgress(body.progress)
                if (body.status === 'done') {
                    setJobId(null)
                    setProgress(null)
                    setEntries([])
                    const result = body.result ?? {}
                    onDone({
                        drafts: (result.drafts ?? [])
                            .map(normalizeDraft)
                            .filter((d): d is Draft => d !== null),
                        warnings: Array.isArray(result.warnings)
                            ? result.warnings.filter((w): w is string => typeof w === 'string')
                            : [],
                        pairing: normalizePairing(result.pairing),
                    })
                    return
                }
                if (body.status === 'failed') {
                    setJobId(null)
                    setProgress(null)
                    setError(body.error || '批量抽题任务失败。')
                    return
                }
                timer = setTimeout(() => void tick(), 1000)
            } catch (err) {
                if (cancelled) return
                setError(err instanceof Error ? err.message : String(err))
                setJobId(null)
            }
        }

        void tick()
        return () => {
            cancelled = true
            if (timer !== undefined) clearTimeout(timer)
        }
    }, [jobId, onDone])

    const running = jobId !== null
    const canStart = entries.length > 0 && !submitting && !running

    return (
        <div className="space-y-4">
            <div className={dropzoneCls}>
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".txt,.md,.pdf"
                    disabled={running}
                    onChange={(e) => addFiles(e.target.files)}
                    className={fileInputCls}
                />
                <p className="mt-2 text-xs text-ink-faint">
                    支持 .txt / .md / .pdf，可多选。教师版（含答案/详解）与学生版会自动配对。
                </p>
            </div>

            {entries.length > 0 && (
                <ul className="space-y-2">
                    {entries.map((e) => (
                        <li
                            key={e.id}
                            className="flex items-center gap-3 rounded-[10px] border border-rule bg-plate px-3 py-2"
                        >
                            <span className="min-w-0 flex-1 truncate text-sm text-ink" title={e.file.name}>
                                {e.file.name}
                            </span>
                            <select
                                value={e.role}
                                disabled={running}
                                onChange={(ev) =>
                                    setEntries((es) =>
                                        es.map((x) => (x.id === e.id ? { ...x, role: ev.target.value as FileRole } : x))
                                    )
                                }
                                className="rounded-[10px] border border-rule bg-plate px-2 py-1 text-xs text-ink-soft focus:outline-none focus:border-beam focus:ring-2 focus:ring-beam-wash transition-colors"
                            >
                                {(Object.keys(ROLE_LABELS) as FileRole[]).map((r) => (
                                    <option key={r} value={r}>
                                        {ROLE_LABELS[r]}
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                disabled={running}
                                onClick={() => setEntries((es) => es.filter((x) => x.id !== e.id))}
                                aria-label={`移除 ${e.file.name}`}
                                className="text-ink-faint hover:text-wrong transition-colors"
                            >
                                ×
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {running && (
                <div className="rounded-[10px] border border-rule bg-paper p-4 space-y-2">
                    <p className="text-sm font-medium text-ink">
                        批量抽题进行中…
                        {progress && (
                            <span className="text-ink-soft">
                                {' '}
                                {STAGE_LABELS[progress.stage] ?? progress.stage} ·{' '}
                                <span className="numeric">
                                    {progress.current}/{progress.total}
                                </span>
                                {progress.file ? ` · ${progress.file}` : ''}
                            </span>
                        )}
                    </p>
                    {progress && progress.total > 0 && (
                        <Lightline value={progress.current} max={progress.total} />
                    )}
                </div>
            )}

            {error && (
                <div className="rounded-[10px] border border-wrong/25 bg-wrong-wash p-4">
                    <p className="text-sm text-wrong">{error}</p>
                    {lastPayloadRef.current && (
                        <div className="mt-2.5">
                            <Button size="sm" variant="secondary" disabled={submitting} onClick={handleRetry}>
                                重试
                            </Button>
                        </div>
                    )}
                </div>
            )}

            <div className="flex justify-end">
                <Button disabled={!canStart} onClick={() => void handleStart()}>
                    {submitting ? '提交中…' : running ? '抽题中…' : '开始批量抽题'}
                </Button>
            </div>
        </div>
    )
}
