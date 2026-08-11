/**
 * 录题页（P1a 单发 + P1b 批量/抽检）：
 * - 「录入」tab：单份（粘贴文本/图片/PDF → /upload）或批量（多文件 → /batch + 任务轮询），
 *   两条路径共用草稿编辑列表与 /confirm 入库。
 * - 「抽检」tab：家长抽检 extracted 题目（核验通过/剔除/跳过）。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { BatchPanel } from './BatchPanel'
import type { BatchOutcome, PairingReport } from './BatchPanel'
import { ReviewTab } from './ReviewTab'
import { Button, PageHeader } from '../ui'
import {
    ANSWER_TYPE_LABELS,
    dropzoneCls,
    extractErrorMessage,
    fileInputCls,
    inputCls,
    LEVEL_LABELS,
    normalizeDraft,
    readFileAsDataUrl,
    todayString,
} from './shared'
import type { AnswerType, ConfirmResult, Draft, Level } from './shared'
import { pdfToPages } from './pdfPages'

type IngestKind = 'text' | 'image' | 'pdf'
type IngestTab = 'input' | 'review'
type InputMode = 'single' | 'batch'

interface BatchReport {
    pairing?: PairingReport
    warnings: string[]
}

function uploadNotReadyHint(kind: IngestKind): string {
    if (kind === 'text') return '服务端抽题流水线尚未就绪（文本抽题需要配置 LLM）。'
    return `服务端抽题流水线尚未就绪（${kind === 'image' ? '图片' : 'PDF'}抽题需要配置 LLM）。`
}

/** 分段控件：录入/抽检、单份/批量、文本/图片/PDF 共用同一套语汇 */
function Segmented<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T
    options: readonly (readonly [T, string])[]
    onChange: (next: T) => void
}) {
    return (
        <div className="inline-flex items-center gap-1 rounded-[10px] border border-rule bg-plate p-1">
            {options.map(([v, label]) => (
                <button
                    key={v}
                    type="button"
                    onClick={() => onChange(v)}
                    aria-pressed={value === v}
                    className={`px-4 py-1.5 rounded-[7px] text-sm font-medium whitespace-nowrap transition-colors ${
                        value === v ? 'bg-beam text-white' : 'text-ink-soft hover:text-ink'
                    }`}
                >
                    {label}
                </button>
            ))}
        </div>
    )
}

export function IngestPage() {
    const [tab, setTab] = useState<IngestTab>('input')
    const [mode, setMode] = useState<InputMode>('single')
    const [kind, setKind] = useState<IngestKind>('text')
    // PDF 逐页渲染 + 识别的进度与说明（整本讲义要跑一两分钟，不能只转个圈）
    const [pdfProgress, setPdfProgress] = useState<{
        done: number
        total: number
        phase: 'render' | 'extract'
    } | null>(null)
    const [pdfNote, setPdfNote] = useState<string | null>(null)
    const [text, setText] = useState('')
    const [file, setFile] = useState<File | null>(null)
    const [batchName, setBatchName] = useState(todayString())
    const [extracting, setExtracting] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [drafts, setDrafts] = useState<Draft[]>([])
    const [batchReport, setBatchReport] = useState<BatchReport | null>(null)
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

    /** 调一次上传端点，返回规范化后的草稿 */
    const uploadOnce = async (payload: { kind: IngestKind; content: string }): Promise<Draft[]> => {
        const res = await fetch('/api/v1/ingest/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, batchName }),
        })
        if (!res.ok) throw new Error(await extractErrorMessage(res, uploadNotReadyHint(payload.kind)))
        const body = (await res.json()) as { drafts?: unknown[] }
        return (body.drafts ?? []).map(normalizeDraft).filter((d): d is Draft => d !== null)
    }

    /**
     * PDF：先在浏览器里把每页渲染成图，再逐页走视觉抽取。
     *
     * 不走服务端抽文本，是因为拿真实讲义量过——文本层里没有数字：
     * 某讲义每页只有约 6 个阿拉伯字符，却有 120 处图形，抽出来的题干长这样：
     * 「一块木板上有 ⟨空⟩ 枚钉子」。带窟窿的题比抽不出来更坏。
     */
    const extractPdf = async () => {
        const buffer = await file!.arrayBuffer()
        let rendered
        try {
            // 体检与渲染在同一趟里做完：pdf.js 会转移走 buffer，
            // 开两次文档第二次就拿到已分离的空壳
            rendered = await pdfToPages(buffer, {
                onProgress: (done, total) => setPdfProgress({ done, total, phase: 'render' }),
            })
        } catch (err) {
            // 说清楚是"本机读不了这个 PDF"，而不是让人误以为是识别模型的问题
            throw new Error(
                `本机读取 PDF 失败：${err instanceof Error ? err.message : String(err)}。` +
                    '可改用「上传图片」把页面拍照或截图后上传。',
            )
        }
        const { verdict, pages } = rendered
        setPdfNote(
            verdict.trustworthy
                ? '正在逐页渲染后识别（数字与图形都在页图里，不会漏）'
                : `${verdict.reason}；已自动改为整页识别`,
        )
        const all: Draft[] = []
        for (const [i, page] of pages.entries()) {
            setPdfProgress({ done: i, total: pages.length, phase: 'extract' })
            try {
                all.push(...(await uploadOnce({ kind: 'image', content: page.dataUrl })))
            } catch (err) {
                // 单页失败不该让整本白跑——记下来继续，最后一并说明
                setPdfNote(`第 ${page.page} 页识别失败（${String(err)}），其余页继续`)
            }
        }
        setPdfProgress({ done: pages.length, total: pages.length, phase: 'extract' })
        return all
    }

    const handleExtract = async () => {
        setError(null)
        setResult(null)
        setBatchReport(null)
        setPdfNote(null)
        setPdfProgress(null)
        setExtracting(true)
        try {
            const next =
                kind === 'pdf'
                    ? await extractPdf()
                    : await uploadOnce({
                          kind,
                          content: kind === 'text' ? text : await readFileAsDataUrl(file!),
                      })
            if (next.length === 0) {
                setError('没有抽取到任何题目，请检查材料内容后重试。')
                return
            }
            setDrafts(next)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setExtracting(false)
            setPdfProgress(null)
        }
    }

    /** 批量任务完成：drafts 灌入同一草稿编辑列表，顶部展示配对报告与 warnings */
    const handleBatchDone = useCallback((outcome: BatchOutcome) => {
        setResult(null)
        setBatchReport({ pairing: outcome.pairing, warnings: outcome.warnings })
        if (outcome.drafts.length === 0) {
            setError('批量任务完成，但没有抽取到任何题目，请检查材料内容后重试。')
            return
        }
        setError(null)
        setDrafts(outcome.drafts)
    }, [])

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
                    // 配图原样带回；服务端入库前会再过一次门禁（前端传的一律不可信）
                    ...(d.figure ? { figure: d.figure } : {}),
                })),
            }
            const res = await fetch('/api/v1/ingest/confirm', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
            })
            if (!res.ok) {
                setError(await extractErrorMessage(res, '服务端入库接口尚未就绪。'))
                return
            }
            const body = (await res.json()) as Partial<ConfirmResult>
            setResult({
                written: body.written ?? 0,
                skippedDuplicates: body.skippedDuplicates ?? 0,
                issues: Array.isArray(body.issues) ? body.issues : [],
            })
            setDrafts([])
            setBatchReport(null)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setConfirming(false)
        }
    }

    return (
        <div className="space-y-6">
            <PageHeader title="题库录入" subtitle="上传讲义或粘贴题目，确认后进入孩子的题库" />

            {/* ── tab 切换：录入 / 抽检 ── */}
            <Segmented
                value={tab}
                onChange={setTab}
                options={
                    [
                        ['input', '录入'],
                        ['review', '抽检'],
                    ] as const
                }
            />

            {tab === 'review' ? (
                <ReviewTab />
            ) : (
                <>
                    {/* ── 输入区 ── */}
                    <section className="plate p-6 space-y-4">
                        <div className="flex items-center justify-between flex-wrap gap-3">
                            <div className="flex items-center gap-3 flex-wrap">
                                <Segmented
                                    value={mode}
                                    onChange={(m) => {
                                        setMode(m)
                                        setError(null)
                                    }}
                                    options={
                                        [
                                            ['single', '单份'],
                                            ['batch', '批量'],
                                        ] as const
                                    }
                                />

                                {mode === 'single' && (
                                    <Segmented
                                        value={kind}
                                        onChange={switchKind}
                                        options={
                                            [
                                                ['text', '粘贴文本'],
                                                ['image', '上传图片'],
                                                ['pdf', '上传 PDF'],
                                            ] as const
                                        }
                                    />
                                )}
                            </div>
                            <label className="flex items-center gap-2">
                                <span className="eyebrow">批次名</span>
                                <input
                                    type="text"
                                    value={batchName}
                                    onChange={(e) => setBatchName(e.target.value)}
                                    className={`${inputCls} numeric w-40`}
                                />
                            </label>
                        </div>

                        {mode === 'batch' ? (
                            <BatchPanel batchName={batchName} onDone={handleBatchDone} />
                        ) : (
                            <>
                                {kind === 'text' ? (
                                    <textarea
                                        value={text}
                                        onChange={(e) => setText(e.target.value)}
                                        rows={8}
                                        placeholder="把题目文本粘贴到这里，一次可以粘贴多道题…"
                                        className={`${inputCls} resize-y font-mono`}
                                    />
                                ) : (
                                    <div className={dropzoneCls}>
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept={kind === 'image' ? 'image/*' : 'application/pdf,.pdf'}
                                            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                                            className={fileInputCls}
                                        />
                                        <p className="mt-2 text-xs text-ink-faint">
                                            {kind === 'image'
                                                ? '支持常见图片格式（拍照的练习册/试卷）'
                                                : '扫描版与文字版都行：会在本机逐页转成图再识别，数字和插图都不会漏'}
                                            {file ? ` · 已选择：${file.name}` : ''}
                                        </p>
                                    </div>
                                )}

                                {/* PDF 要逐页渲染再逐页识别，几十页要跑一两分钟——
                                    只转个圈会让人以为卡死了，把页码报出来 */}
                                {(pdfProgress || pdfNote) && (
                                    <div className="rounded-[10px] bg-beam-wash border border-beam/20 px-4 py-2.5 space-y-1">
                                        {pdfProgress && (
                                            <p className="text-sm text-beam font-medium">
                                                {pdfProgress.phase === 'render' ? '渲染页面' : '识别题目'}
                                                <span className="numeric">
                                                    {' '}
                                                    {pdfProgress.done} / {pdfProgress.total}
                                                </span>
                                            </p>
                                        )}
                                        {pdfNote && <p className="text-xs text-ink-soft leading-relaxed">{pdfNote}</p>}
                                    </div>
                                )}

                                <div className="flex justify-end">
                                    <Button disabled={!canExtract} onClick={() => void handleExtract()}>
                                        {extracting ? '抽题中…' : '抽题'}
                                    </Button>
                                </div>
                            </>
                        )}
                    </section>

                    {/* ── 批量配对报告 ── */}
                    {batchReport && (
                        <div className="rounded-[10px] border border-beam/20 bg-beam-wash p-4 space-y-1.5">
                            {batchReport.pairing && (
                                <p className="text-sm font-semibold text-beam">
                                    配对报告：配对 <span className="numeric">{batchReport.pairing.matched}</span> 题 ·
                                    仅教师版 <span className="numeric">{batchReport.pairing.teacherOnly}</span> 题 ·
                                    仅学生版 <span className="numeric">{batchReport.pairing.studentOnly}</span> 题
                                </p>
                            )}
                            {batchReport.warnings.length > 0 && (
                                <ul className="list-disc pl-5 text-xs text-ink-soft">
                                    {batchReport.warnings.map((w, i) => (
                                        <li key={i}>{w}</li>
                                    ))}
                                </ul>
                            )}
                            {!batchReport.pairing && batchReport.warnings.length === 0 && (
                                <p className="text-sm text-beam">批量任务完成。</p>
                            )}
                        </div>
                    )}

                    {/* ── 错误提示 ── */}
                    {error && (
                        <div className="rounded-[10px] border border-wrong/25 bg-wrong-wash p-4">
                            <p className="text-sm text-wrong">{error}</p>
                        </div>
                    )}

                    {/* ── 入库结果 ── */}
                    {result && (
                        <div className="rounded-[10px] border border-correct/25 bg-correct-wash p-4 space-y-1.5">
                            <p className="text-sm font-semibold text-[color:var(--color-correct)]">
                                入库完成：写入 <span className="numeric">{result.written}</span> 题，跳过重复{' '}
                                <span className="numeric">{result.skippedDuplicates}</span> 题
                            </p>
                            {result.issues.length > 0 && (
                                <ul className="list-disc pl-5 text-xs text-ink-soft">
                                    {result.issues.map((issue, i) => (
                                        <li key={i}>{issue}</li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {/* ── 草稿确认区（单发/批量共用） ── */}
                    {drafts.length > 0 && (
                        <section className="space-y-4">
                            <div className="flex items-center justify-between gap-3 flex-wrap">
                                <h2 className="text-section">
                                    抽取到 <span className="numeric">{drafts.length}</span> 道题 · 请核对后入库
                                </h2>
                                <Button disabled={confirming} onClick={() => void handleConfirm()}>
                                    {confirming ? '入库中…' : '确认入库'}
                                </Button>
                            </div>

                            {drafts.map((d, idx) => (
                                <div key={d.key} className="plate p-5 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="eyebrow">
                                            第 <span className="numeric">{idx + 1}</span> 题
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))}
                                            className="text-xs text-ink-faint hover:text-wrong transition-colors"
                                        >
                                            删除此题
                                        </button>
                                    </div>

                                    <label className="block">
                                        <span className="eyebrow block mb-1">题干</span>
                                        <textarea
                                            value={d.stem}
                                            onChange={(e) => updateDraft(d.key, { stem: e.target.value })}
                                            rows={3}
                                            className={`${inputCls} mt-1 resize-y`}
                                        />
                                    </label>

                                    {d.options && d.options.length > 0 && (
                                        <p className="text-xs text-ink-soft">选项：{d.options.join(' / ')}</p>
                                    )}

                                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                                        <label className="block">
                                            <span className="eyebrow block mb-1">答案</span>
                                            <input
                                                type="text"
                                                value={d.answer}
                                                onChange={(e) => updateDraft(d.key, { answer: e.target.value })}
                                                className={`${inputCls} numeric mt-1`}
                                            />
                                        </label>
                                        <label className="block">
                                            <span className="eyebrow block mb-1">答案类型</span>
                                            <select
                                                value={d.answerType}
                                                onChange={(e) =>
                                                    updateDraft(d.key, { answerType: e.target.value as AnswerType })
                                                }
                                                className={`${inputCls} mt-1`}
                                            >
                                                {(Object.keys(ANSWER_TYPE_LABELS) as AnswerType[]).map((t) => (
                                                    <option key={t} value={t}>
                                                        {ANSWER_TYPE_LABELS[t]}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="block">
                                            <span className="eyebrow block mb-1">难度 1-5</span>
                                            <select
                                                value={d.difficulty}
                                                onChange={(e) =>
                                                    updateDraft(d.key, { difficulty: Number(e.target.value) })
                                                }
                                                className={`${inputCls} numeric mt-1`}
                                            >
                                                {[1, 2, 3, 4, 5].map((n) => (
                                                    <option key={n} value={n}>
                                                        {n} · {'★'.repeat(n)}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        <label className="block">
                                            <span className="eyebrow block mb-1">学段</span>
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

                                    <div>
                                        <span className="eyebrow block mb-1">关联知识点 · AI 建议可删除</span>
                                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                                            {d.nodes.length === 0 && (
                                                <span className="text-xs text-ink-faint">（无建议知识点）</span>
                                            )}
                                            {d.nodes.map((n) => (
                                                <span
                                                    key={n.nodeId}
                                                    className="inline-flex items-center gap-1.5 rounded-md border border-beam/20 bg-beam-wash px-2.5 py-1 text-xs text-beam"
                                                >
                                                    {n.nodeId}
                                                    {typeof n.confidence === 'number' && (
                                                        <span className="numeric opacity-70">
                                                            {Math.round(n.confidence * 100)}%
                                                        </span>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => removeNode(d.key, n.nodeId)}
                                                        aria-label={`移除 ${n.nodeId}`}
                                                        className="ml-0.5 text-ink-faint hover:text-wrong transition-colors"
                                                    >
                                                        ×
                                                    </button>
                                                </span>
                                            ))}
                                        </div>

                                        {/* 配图与提议的处理结果：抽检时要看得见系统替你丢掉了什么 */}
                                        {d.figure ? (
                                            <p className="mt-2 text-xs text-[color:var(--color-correct)]">
                                                已带配图（条件与题干核对通过）
                                            </p>
                                        ) : null}
                                        {d.figureRejected && (
                                            <p className="mt-2 text-xs text-[color:var(--color-wrong)] leading-relaxed">
                                                配图已丢弃：{d.figureRejected}
                                            </p>
                                        )}
                                        {d.droppedSuggestions?.length ? (
                                            <p className="mt-1.5 text-xs text-ink-faint leading-relaxed">
                                                模型还提到「{d.droppedSuggestions.join('、')}」，
                                                但图谱里没有对应的知识点——这也是补大纲的线索。
                                            </p>
                                        ) : null}
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}

                    {drafts.length === 0 && !result && !error && (
                        <p className="text-center text-sm text-ink-faint">
                            抽题后会在这里生成草稿列表，核对无误再「确认入库」。
                        </p>
                    )}
                </>
            )}
        </div>
    )
}
