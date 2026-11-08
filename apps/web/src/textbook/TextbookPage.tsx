import { useCallback, useEffect, useMemo, useState } from 'react'

import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from '../ui'
import {
    alignBook,
    confirmPlan,
    getCompileJob,
    getCompiledBook,
    listCompiledBooks,
    startCompile,
    type AlignResult,
    type CompiledBook,
    type CompileJob,
    type ConfirmResult,
} from './api'
import { coverageLabel, pollCompileJob, presetChoices, toLessons } from './flow'

/**
 * 教材页（仅家长）：把一本教材编译成概念清单，再由家长把概念对到图谱节点上。
 *
 * 这一页存在的理由不是"展示进度条"，而是**把关口放到人眼前**：
 * - 哪些概念的出处真的在书里（`verified`），哪些只是模型的自述；
 * - 每个概念给了哪些候选、凭什么给（`reasons`）；
 * - 排课为什么这么排（`movedBecauseOf`）。
 *
 * 三件事都不做自动决定。教材编译的产物再漂亮，最后点头的必须是人——
 * 这条约束在 PLAN 里是硬要求，在这里的体现就是：确认按钮之前，没有一个节点被写进图谱。
 */

const fieldCls =
    'w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px] placeholder:text-ink-faint focus:outline-none focus:border-beam focus:ring-2 focus:ring-beam-wash transition-colors'

/** 读成 base64 data URL：服务端会去掉前缀，这里不重复处理 */
function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
    })
}

type Phase = 'idle' | 'compiling' | 'compiled' | 'aligned' | 'planned'

export function TextbookPage() {
    const [phase, setPhase] = useState<Phase>('idle')
    const [title, setTitle] = useState('')
    const [file, setFile] = useState<File | null>(null)
    const [job, setJob] = useState<CompileJob | null>(null)
    const [book, setBook] = useState<CompiledBook | null>(null)
    const [align, setAlign] = useState<AlignResult | null>(null)
    const [choice, setChoice] = useState<Record<string, string>>({})
    const [plan, setPlan] = useState<ConfirmResult | null>(null)
    const [books, setBooks] = useState<{ name: string; conceptCount: number; chapters: number; degraded: boolean }[]>([])
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const refreshBooks = useCallback(async () => {
        try {
            setBooks((await listCompiledBooks()).books)
        } catch {
            /* 书目列表是附带的，拉不到不影响主流程 */
        }
    }, [])

    useEffect(() => {
        void refreshBooks()
    }, [refreshBooks])

    /** 等编译跑完：失败立刻把服务端的错误抛出来，进度每轮都刷到页面上 */
    const poll = useCallback(
        async (jobId: string, bookTitle: string) => {
            const done = await pollCompileJob(getCompileJob, jobId, { onProgress: setJob })
            const full = await getCompiledBook(bookTitle)
            setBook(full)
            setPhase('compiled')
            void refreshBooks()
            void done
        },
        [refreshBooks],
    )

    const onCompile = async () => {
        if (!file) return
        setError(null)
        setBusy(true)
        try {
            const pdfBase64 = await readFileAsDataUrl(file)
            const bookTitle = title.trim() || file.name.replace(/\.pdf$/i, '')
            const started = await startCompile({ title: bookTitle, pdfBase64 })
            if (!started.jobId) throw new Error('服务端没有返回任务号')
            setTitle(bookTitle)
            setPhase('compiling')
            await poll(started.jobId, bookTitle)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
            setPhase('idle')
        } finally {
            setBusy(false)
        }
    }

    const onAlign = async () => {
        if (!book) return
        setError(null)
        setBusy(true)
        try {
            const result = await alignBook(book.title)
            setAlign(result)
            setChoice(presetChoices(result.items))
            setPhase('aligned')
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const onConfirm = async () => {
        if (!book) return
        const lessons = toLessons(choice)
        if (lessons.length === 0) {
            setError('还没有选中任何映射：至少把一个概念对到一个知识点上')
            return
        }
        setError(null)
        setBusy(true)
        try {
            setPlan(await confirmPlan(book.title, lessons))
            setPhase('planned')
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const verifiedCount = book?.concepts.filter((c) => c.verified).length ?? 0
    const coverageText = useMemo(() => coverageLabel(book?.coverage), [book])

    return (
        <div className="space-y-6">
            <PageHeader
                title="教材"
                subtitle="把一本教材编译成概念清单，逐条核对后再排成课程——图谱不会自动被改"
            />

            {error && <ErrorState message={error} onRetry={() => setError(null)} />}

            <Card className="p-5 space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                    <label className="flex-1 min-w-[220px]">
                        <span className="eyebrow block mb-2">教材名（可留空，用文件名）</span>
                        <input
                            className={fieldCls}
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="数学 五年级上"
                        />
                    </label>
                    <label className="flex-1 min-w-[220px]">
                        <span className="eyebrow block mb-2">PDF</span>
                        <input
                            type="file"
                            accept="application/pdf,.pdf"
                            className={fieldCls}
                            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                        />
                    </label>
                    <Button onClick={() => void onCompile()} disabled={busy || !file}>
                        {phase === 'compiling' ? '正在编译…' : '开始编译'}
                    </Button>
                </div>

                {phase === 'compiling' && job && (
                    <div className="text-sm text-ink-soft">
                        编译 {job.progress.current ?? 0}/{job.progress.total ?? '?'} 章
                        {job.progress.chapter ? `（最近：${job.progress.chapter}）` : ''}
                        <span className="ml-2 text-ink-faint">一本书要十几分钟，可以先干别的</span>
                    </div>
                )}
                {phase === 'compiling' && !job && <LoadingState text="已提交，正在切章…" />}

                {books.length > 0 && (
                    <div className="text-xs text-ink-faint">
                        已编译：{books.map((b) => `${b.name}（${b.conceptCount} 个概念${b.degraded ? '·有降级' : ''}）`).join('；')}
                    </div>
                )}
            </Card>

            {book && (
                <Card className="p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h3 className="text-lg font-semibold text-ink">{book.title}</h3>
                            {coverageText && <div className="text-xs text-ink-faint mt-1">{coverageText}</div>}
                        </div>
                        <div className="flex items-center gap-2">
                            {book.degraded && <Badge tone="amber">有章节走了离线兜底</Badge>}
                            <Badge tone={verifiedCount > 0 ? 'beam' : 'red'}>
                                {verifiedCount}/{book.concepts.length} 条有据可查
                            </Badge>
                            <Button variant="secondary" size="sm" onClick={() => void onAlign()} disabled={busy}>
                                生成图谱候选
                            </Button>
                        </div>
                    </div>

                    {book.concepts.length === 0 ? (
                        <EmptyState title="这本书没有编译出概念" hint="可能是扫描版（没有文本层），或切章没认出结构" />
                    ) : (
                        <ul className="space-y-3">
                            {book.concepts.map((concept) => (
                                <li key={concept.id} className="border border-rule rounded-[10px] p-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-medium text-ink">{concept.title}</span>
                                        {concept.verified ? (
                                            <Badge tone="emerald">出处已核</Badge>
                                        ) : (
                                            <Badge tone="red">出处未定位</Badge>
                                        )}
                                        {concept.conflictCount > 0 && <Badge tone="amber">书里说法不一致</Badge>}
                                        <span className="text-xs text-ink-faint">
                                            出处 {concept.verifiedSourceCount}/{concept.sourceCount}
                                            {concept.keyPointCount > 0 ? ` · 要点 ${concept.keyPointCount}` : ''}
                                        </span>
                                    </div>
                                    <p className="text-sm text-ink-soft mt-1">{concept.definition}</p>
                                    {concept.sources.slice(0, 2).map((source, i) => (
                                        <div key={i} className="mt-1 text-xs text-ink-faint">
                                            《{source.chapterTitle}》p{source.fromPage}–{source.toPage}
                                            {source.verification === 'not_found'
                                                ? ' · 引文未能在原文定位（不作出处展示）'
                                                : source.verification === 'partial'
                                                  ? ' · 部分句子能定位'
                                                  : ''}
                                        </div>
                                    ))}
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>
            )}

            {align && book && (
                <Card className="p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h3 className="text-lg font-semibold text-ink">把概念对到知识点</h3>
                            <div className="text-xs text-ink-faint mt-1">
                                {align.items.length} 条待核对
                                {align.skippedUnverified > 0
                                    ? ` · ${align.skippedUnverified} 条没有可定位出处，不参与对齐`
                                    : ''}
                            </div>
                        </div>
                        <Button onClick={() => void onConfirm()} disabled={busy}>
                            确认并排课
                        </Button>
                    </div>

                    <ul className="space-y-3">
                        {align.items.map((item) => (
                            <li key={item.conceptId} className="border border-rule rounded-[10px] p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="font-medium text-ink">{item.conceptTitle}</span>
                                    <select
                                        className="px-2 py-1 text-sm bg-plate border border-rule rounded-[8px] text-ink"
                                        value={choice[item.conceptId] ?? ''}
                                        onChange={(e) =>
                                            setChoice((prev) => ({ ...prev, [item.conceptId]: e.target.value }))
                                        }
                                    >
                                        <option value="">不对到任何知识点</option>
                                        {item.candidates.map((candidate) => (
                                            <option key={candidate.nodeId} value={candidate.nodeId}>
                                                {candidate.nodeName}（{candidate.score.toFixed(0)}）
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                {item.candidates.length === 0 ? (
                                    <div className="text-xs text-ink-faint mt-1">
                                        图谱里没有对得上的知识点——这种情况留空更诚实
                                    </div>
                                ) : (
                                    <div className="text-xs text-ink-faint mt-1">
                                        候选理由：{item.candidates[0]!.reasons.slice(0, 4).join('、') || '名称相近'}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                </Card>
            )}

            {plan && (
                <Card className="p-5 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-lg font-semibold text-ink">课程计划</h3>
                        <span className="text-xs text-ink-faint">{plan.savedTo}</span>
                    </div>
                    {plan.cycleDetected && (
                        <div className="text-xs text-amber-600">图谱里这几节之间有环，已退回原书顺序</div>
                    )}
                    <ol className="space-y-2">
                        {plan.lessons.map((lesson) => (
                            <li key={`${lesson.order}-${lesson.nodeId}`} className="flex flex-wrap items-baseline gap-2 text-sm">
                                <span className="numeric text-ink-faint w-6">{lesson.order}</span>
                                <span className="text-ink font-medium">{lesson.nodeName}</span>
                                <span className="text-xs text-ink-faint">← {lesson.chapterTitle}</span>
                                {lesson.movedBecauseOf.map((why) => (
                                    <span key={why} className="text-xs text-beam">
                                        {why}
                                    </span>
                                ))}
                            </li>
                        ))}
                    </ol>
                </Card>
            )}
        </div>
    )
}
