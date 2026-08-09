/**
 * P1a 录题页：粘贴文本 / 上传图片 / 上传 PDF → POST /api/v1/ingest/upload 抽题
 * → 草稿可编辑确认 → POST /api/v1/ingest/confirm 入库。
 * 服务端未就绪（501）或出错时给出清晰提示。
 */
import { useMemo, useRef, useState } from 'react'

type IngestKind = 'text' | 'image' | 'pdf'
type AnswerType = 'numeric' | 'expression' | 'steps'
type Level = 'elementary_lower' | 'elementary_upper' | 'middle' | 'high' | 'advanced'

const LEVEL_LABELS: Record<Level, string> = {
    elementary_lower: '小学低年级',
    elementary_upper: '小学高年级',
    middle: '初中',
    high: '高中',
    advanced: '进阶',
}

const ANSWER_TYPE_LABELS: Record<AnswerType, string> = {
    numeric: '数值',
    expression: '表达式',
    steps: '解答步骤',
}

interface NodeSuggestion {
    nodeId: string
    confidence?: number
}

/** 客户端草稿：由 upload 返回的 drafts 归一化而来，可编辑 */
interface Draft {
    key: string
    stem: string
    answer: string
    answerType: AnswerType
    difficulty: number
    level: Level
    options?: string[]
    analysis?: string
    nodes: NodeSuggestion[]
}

interface ConfirmResult {
    written: number
    skippedDuplicates: number
    issues: string[]
}

let draftSeq = 0

/** 容错归一化：suggestedNodeIds 可能是 string[] 或 {nodeId,confidence}[]，也可能落在 nodeIds */
function normalizeNodes(raw: unknown): NodeSuggestion[] {
    if (!Array.isArray(raw)) return []
    const out: NodeSuggestion[] = []
    for (const item of raw) {
        if (typeof item === 'string') {
            out.push({ nodeId: item })
        } else if (item && typeof item === 'object') {
            const o = item as { nodeId?: unknown; id?: unknown; confidence?: unknown }
            const nodeId = typeof o.nodeId === 'string' ? o.nodeId : typeof o.id === 'string' ? o.id : null
            if (nodeId) {
                out.push({
                    nodeId,
                    confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
                })
            }
        }
    }
    return out
}

function normalizeDraft(raw: unknown): Draft | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (typeof o.stem !== 'string' || !o.stem.trim()) return null
    const answerType: AnswerType =
        o.answerType === 'expression' || o.answerType === 'steps' ? o.answerType : 'numeric'
    const level: Level =
        typeof o.level === 'string' && o.level in LEVEL_LABELS ? (o.level as Level) : 'elementary_upper'
    const difficulty =
        typeof o.difficulty === 'number' ? Math.min(5, Math.max(1, Math.round(o.difficulty))) : 3
    return {
        key: `draft-${++draftSeq}`,
        stem: o.stem,
        answer: typeof o.answer === 'string' ? o.answer : '',
        answerType,
        difficulty,
        level,
        options: Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : undefined,
        analysis: typeof o.analysis === 'string' ? o.analysis : undefined,
        nodes: normalizeNodes(o.suggestedNodeIds ?? o.nodeIds),
    }
}

function todayString(): string {
    const d = new Date()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${mm}-${dd}`
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('文件读取失败'))
        reader.readAsDataURL(file)
    })
}

async function extractErrorMessage(res: Response, kind: IngestKind): Promise<string> {
    let serverMsg = ''
    try {
        const body = (await res.json()) as { error?: unknown; message?: unknown }
        serverMsg = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : ''
    } catch {
        /* 非 JSON 响应 */
    }
    if (res.status === 501) {
        const hint =
            kind === 'text'
                ? '服务端抽题流水线尚未就绪（文本抽题需要配置 LLM）。'
                : `服务端抽题流水线尚未就绪（${kind === 'image' ? '图片' : 'PDF'}抽题需要配置 LLM）。`
        return serverMsg ? `${hint}（${serverMsg}）` : hint
    }
    return serverMsg || `请求失败 (HTTP ${res.status})`
}

const inputCls =
    'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-300'

export function IngestPage() {
    const [kind, setKind] = useState<IngestKind>('text')
    const [text, setText] = useState('')
    const [file, setFile] = useState<File | null>(null)
    const [batchName, setBatchName] = useState(todayString())
    const [extracting, setExtracting] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [drafts, setDrafts] = useState<Draft[]>([])
    const [result, setResult] = useState<ConfirmResult | null>(null)
    const fileInputRef = useRef<HTMLInputElement | null>(null)

    const canExtract = useMemo(() => {
        if (extracting) return false
        return kind === 'text' ? text.trim().length > 0 : file !== null
    }, [kind, text, file, extracting])

    const switchKind = (next: IngestKind) => {
        setKind(next)
        setFile(null)
        setError(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
    }

    const handleExtract = async () => {
        setError(null)
        setResult(null)
        setExtracting(true)
        try {
            const content = kind === 'text' ? text : await readFileAsDataUrl(file!)
            const res = await fetch('/api/v1/ingest/upload', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ kind, content, batchName }),
            })
            if (!res.ok) {
                setError(await extractErrorMessage(res, kind))
                return
            }
            const body = (await res.json()) as { drafts?: unknown[] }
            const next = (body.drafts ?? [])
                .map(normalizeDraft)
                .filter((d): d is Draft => d !== null)
            if (next.length === 0) {
                setError('没有抽取到任何题目，请检查材料内容后重试。')
                return
            }
            setDrafts(next)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setExtracting(false)
        }
    }

    const updateDraft = (key: string, patch: Partial<Draft>) => {
        setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)))
    }

    const removeNode = (key: string, nodeId: string) => {
        setDrafts((ds) =>
            ds.map((d) => (d.key === key ? { ...d, nodes: d.nodes.filter((n) => n.nodeId !== nodeId) } : d))
        )
    }

    const handleConfirm = async () => {
        setError(null)
        setConfirming(true)
        try {
            const payload = {
                batchName,
                questions: drafts.map((d) => ({
                    stem: d.stem,
                    answer: d.answer,
                    answerType: d.answerType,
                    difficulty: d.difficulty,
                    level: d.level,
                    nodeIds: d.nodes.map((n) => n.nodeId),
                    ...(d.options?.length ? { options: d.options } : {}),
                    ...(d.analysis ? { analysis: d.analysis } : {}),
                })),
            }
            const res = await fetch('/api/v1/ingest/confirm', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
            })
            if (!res.ok) {
                setError(await extractErrorMessage(res, kind))
                return
            }
            const body = (await res.json()) as Partial<ConfirmResult>
            setResult({
                written: body.written ?? 0,
                skippedDuplicates: body.skippedDuplicates ?? 0,
                issues: Array.isArray(body.issues) ? body.issues : [],
            })
            setDrafts([])
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setConfirming(false)
        }
    }

    return (
        <div className="space-y-6">
            {/* ── 输入区 ── */}
            <section className="soft-glass p-1">
                <div className="rounded-[1.4rem] bg-white/60 p-6 backdrop-blur-sm space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                        <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white p-1">
                            {(
                                [
                                    ['text', '粘贴文本'],
                                    ['image', '上传图片'],
                                    ['pdf', '上传 PDF'],
                                ] as const
                            ).map(([k, label]) => (
                                <button
                                    key={k}
                                    type="button"
                                    onClick={() => switchKind(k)}
                                    className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                                        kind === k ? 'bg-sky-500 text-white shadow' : 'text-slate-500 hover:text-slate-800'
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <label className="flex items-center gap-2 text-sm text-slate-500">
                            批次名
                            <input
                                type="text"
                                value={batchName}
                                onChange={(e) => setBatchName(e.target.value)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-300"
                            />
                        </label>
                    </div>

                    {kind === 'text' ? (
                        <textarea
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            rows={8}
                            placeholder="把题目文本粘贴到这里，一次可以粘贴多道题…"
                            className={`${inputCls} resize-y font-mono`}
                        />
                    ) : (
                        <div className="rounded-xl border-2 border-dashed border-slate-200 bg-white/60 p-6 text-center">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept={kind === 'image' ? 'image/*' : 'application/pdf,.pdf'}
                                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                                className="mx-auto block text-sm text-slate-500 file:mr-3 file:rounded-full file:border-0 file:bg-sky-100 file:px-4 file:py-1.5 file:text-sm file:font-medium file:text-sky-700 hover:file:bg-sky-200"
                            />
                            <p className="mt-2 text-xs text-slate-400">
                                {kind === 'image' ? '支持常见图片格式（拍照的练习册/试卷）' : '支持 PDF 讲义或试卷'}
                                {file ? ` · 已选择：${file.name}` : ''}
                            </p>
                        </div>
                    )}

                    <div className="flex justify-end">
                        <button
                            type="button"
                            disabled={!canExtract}
                            onClick={handleExtract}
                            className="rounded-full bg-sky-500 px-6 py-2 text-sm font-semibold text-white shadow transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-slate-300"
                        >
                            {extracting ? '抽题中…' : '抽题'}
                        </button>
                    </div>
                </div>
            </section>

            {/* ── 错误提示 ── */}
            {error && (
                <div className="rounded-xl border-l-4 border-red-400 bg-red-50/70 p-4">
                    <p className="text-sm text-red-600">{error}</p>
                </div>
            )}

            {/* ── 入库结果 ── */}
            {result && (
                <div className="rounded-xl border-l-4 border-emerald-400 bg-emerald-50/70 p-4 space-y-1">
                    <p className="text-sm font-semibold text-emerald-700">
                        入库完成：写入 {result.written} 题，跳过重复 {result.skippedDuplicates} 题
                    </p>
                    {result.issues.length > 0 && (
                        <ul className="list-disc pl-5 text-xs text-amber-700">
                            {result.issues.map((issue, i) => (
                                <li key={i}>{issue}</li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* ── 草稿确认区 ── */}
            {drafts.length > 0 && (
                <section className="space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-semibold text-slate-700">
                            抽取到 {drafts.length} 道题 · 请核对后入库
                        </h2>
                        <button
                            type="button"
                            disabled={confirming}
                            onClick={handleConfirm}
                            className="rounded-full bg-emerald-500 px-6 py-2 text-sm font-semibold text-white shadow transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-300"
                        >
                            {confirming ? '入库中…' : '确认入库'}
                        </button>
                    </div>

                    {drafts.map((d, idx) => (
                        <div key={d.key} className="rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm space-y-3">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-semibold text-slate-400">第 {idx + 1} 题</span>
                                <button
                                    type="button"
                                    onClick={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))}
                                    className="text-xs text-slate-400 hover:text-red-500"
                                >
                                    删除此题
                                </button>
                            </div>

                            <label className="block text-xs text-slate-500">
                                题干
                                <textarea
                                    value={d.stem}
                                    onChange={(e) => updateDraft(d.key, { stem: e.target.value })}
                                    rows={3}
                                    className={`${inputCls} mt-1 resize-y`}
                                />
                            </label>

                            {d.options && d.options.length > 0 && (
                                <p className="text-xs text-slate-500">选项：{d.options.join(' / ')}</p>
                            )}

                            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                                <label className="block text-xs text-slate-500">
                                    答案
                                    <input
                                        type="text"
                                        value={d.answer}
                                        onChange={(e) => updateDraft(d.key, { answer: e.target.value })}
                                        className={`${inputCls} mt-1`}
                                    />
                                </label>
                                <label className="block text-xs text-slate-500">
                                    答案类型
                                    <select
                                        value={d.answerType}
                                        onChange={(e) => updateDraft(d.key, { answerType: e.target.value as AnswerType })}
                                        className={`${inputCls} mt-1`}
                                    >
                                        {(Object.keys(ANSWER_TYPE_LABELS) as AnswerType[]).map((t) => (
                                            <option key={t} value={t}>
                                                {ANSWER_TYPE_LABELS[t]}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="block text-xs text-slate-500">
                                    难度（1-5）
                                    <select
                                        value={d.difficulty}
                                        onChange={(e) => updateDraft(d.key, { difficulty: Number(e.target.value) })}
                                        className={`${inputCls} mt-1`}
                                    >
                                        {[1, 2, 3, 4, 5].map((n) => (
                                            <option key={n} value={n}>
                                                {'★'.repeat(n)}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="block text-xs text-slate-500">
                                    学段
                                    <select
                                        value={d.level}
                                        onChange={(e) => updateDraft(d.key, { level: e.target.value as Level })}
                                        className={`${inputCls} mt-1`}
                                    >
                                        {(Object.keys(LEVEL_LABELS) as Level[]).map((lv) => (
                                            <option key={lv} value={lv}>
                                                {LEVEL_LABELS[lv]}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>

                            <div className="text-xs text-slate-500">
                                关联知识点（AI 建议，可删除）
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    {d.nodes.length === 0 && <span className="text-slate-400">（无建议知识点）</span>}
                                    {d.nodes.map((n) => (
                                        <span
                                            key={n.nodeId}
                                            className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs text-sky-700"
                                        >
                                            {n.nodeId}
                                            {typeof n.confidence === 'number' && (
                                                <span className="text-sky-400">{Math.round(n.confidence * 100)}%</span>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => removeNode(d.key, n.nodeId)}
                                                aria-label={`移除 ${n.nodeId}`}
                                                className="ml-0.5 text-sky-300 hover:text-red-500"
                                            >
                                                ×
                                            </button>
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ))}
                </section>
            )}

            {drafts.length === 0 && !result && !error && (
                <p className="text-center text-sm text-slate-400">
                    抽题后会在这里生成草稿列表，核对无误再「确认入库」。
                </p>
            )}
        </div>
    )
}
