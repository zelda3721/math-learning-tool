/**
 * 题库管理（家长）。
 *
 * 此前题一旦通过抽检就在界面上失联了——发现答案错了只能去翻 JSON。
 * 这一页把全部题目摊开：按批次/状态/学段/知识点筛、题干搜索、就地改、
 * 单题删、整批撤回。所有修改走服务端同一套校验（知识点必须存在、
 * 配图必须与题干对得上），手改 JSON 绕得过的检查，这里绕不过。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, ErrorState, Field, LoadingState, PageHeader } from '../ui'
import { QuestionFigure } from '../practice/QuestionFigure'
import { QuestionImage } from '../practice/QuestionImage'
import type { FigureSpec } from '@mathtutor/explainer-web'

interface BankQuestion {
    id: string
    batch: string
    stem: string
    answer: string
    answerType: string
    difficulty: number
    level: string
    nodeIds: string[]
    problemTypeId?: string
    analysis?: string
    status: string
    answerUnverified?: boolean
    figureImage?: string
    analysisImage?: string
    figure?: unknown
}

interface BankList {
    total: number
    matched: number
    items: BankQuestion[]
    facets: {
        status: Record<string, number>
        level: Record<string, number>
        batch: Record<string, number>
        withFigure: number
        blocked: number
    }
}

const LEVEL_LABEL: Record<string, string> = {
    elementary_lower: '小学低年级',
    elementary_upper: '小学高年级',
    middle: '初中',
    high: '高中',
    advanced: '进阶',
}
const STATUS_LABEL: Record<string, string> = { extracted: '待抽检', verified: '已核对' }

export function BankPage() {
    const [list, setList] = useState<BankList | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [query, setQuery] = useState('')
    const [status, setStatus] = useState('')
    const [batch, setBatch] = useState('')
    const [blockedOnly, setBlockedOnly] = useState(false)
    const [editing, setEditing] = useState<BankQuestion | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    const load = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
            const params = new URLSearchParams({ limit: '200' })
            if (query.trim()) params.set('q', query.trim())
            if (status) params.set('status', status)
            if (batch) params.set('batch', batch)
            if (blockedOnly) params.set('blocked', '1')
            const res = await fetch(`/api/v1/bank/questions?${params}`)
            if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`)
            setList((await res.json()) as BankList)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }, [query, status, batch, blockedOnly])

    useEffect(() => {
        void load()
    }, [load])

    const batches = useMemo(
        () => Object.entries(list?.facets.batch ?? {}).sort((a, b) => b[1] - a[1]),
        [list],
    )

    /**
     * 重新归类答案类型。模型标的不可信——纯数值题被标成 steps 时，
     * 孩子做对了也只会看到"已交给家长确认"，掌握度不计、也进不了变式题池。
     * 入库时已按答案推导，这个按钮是给入库之前就存在的题补一次。
     */
    const reclassify = async () => {
        const res = await fetch('/api/v1/bank/reclassify', { method: 'POST' })
        const body = (await res.json()) as { changed?: number; error?: string }
        setNotice(res.ok ? `已重新归类 ${body.changed} 道题的答案类型` : (body.error ?? '归类失败'))
        void load()
    }

    const removeOne = async (q: BankQuestion) => {
        if (!window.confirm(`删除这道题？\n\n${q.stem.slice(0, 40)}…`)) return
        const res = await fetch(`/api/v1/bank/questions/${encodeURIComponent(q.id)}`, { method: 'DELETE' })
        setNotice(res.ok ? '已删除' : '删除失败')
        void load()
    }

    const withdrawBatch = async (name: string, count: number) => {
        // 要求把批次名再打一遍：几百道题不能手滑删掉
        const typed = window.prompt(`整批撤回会删掉「${name}」里的 ${count} 道题。\n请输入批次名确认：`)
        if (typed === null) return
        const res = await fetch(`/api/v1/bank/batches/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: typed }),
        })
        const body = (await res.json()) as { removed?: number; error?: string }
        setNotice(res.ok ? `已撤回 ${body.removed} 道题` : (body.error ?? '撤回失败'))
        void load()
    }

    if (error) return <ErrorState message={error} onRetry={() => void load()} />

    return (
        <div className="space-y-4">
            <PageHeader
                title="题库"
                subtitle={
                    list
                        ? `共 ${list.total} 道 · ${list.facets.status.extracted ?? 0} 道待抽检 · ${list.facets.withFigure} 道带配图` +
                          (list.facets.blocked > 0 ? ` · ${list.facets.blocked} 道暂不发给孩子` : '')
                        : '加载中'
                }
            />

            <div className="plate p-4 space-y-3">
                <div className="flex flex-wrap gap-2 items-end">
                    <div className="flex-1 min-w-[200px]">
                        <Field label="搜索题干或答案">
                            <input
                                className="input-hero !text-base !py-2"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="例：长方形"
                            />
                        </Field>
                    </div>
                    <select
                        className="rounded-[10px] border border-rule bg-plate px-3 py-2 text-sm text-ink"
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                    >
                        <option value="">全部状态</option>
                        <option value="extracted">待抽检</option>
                        <option value="verified">已核对</option>
                    </select>
                    <select
                        className="rounded-[10px] border border-rule bg-plate px-3 py-2 text-sm text-ink max-w-[220px]"
                        value={batch}
                        onChange={(e) => setBatch(e.target.value)}
                    >
                        <option value="">全部批次</option>
                        {batches.map(([name, n]) => (
                            <option key={name} value={name}>
                                {name}（{n}）
                            </option>
                        ))}
                    </select>
                </div>

                {/* 答案是模型自己算的那些，核对之前拿不到孩子手上——
                    这是最该先看的一批，给它一个直达入口 */}
                <label className="flex items-center gap-2 text-sm text-ink-soft">
                    <input
                        type="checkbox"
                        checked={blockedOnly}
                        onChange={(e) => setBlockedOnly(e.target.checked)}
                    />
                    只看「答案是模型自己算的、还没核对」
                    {list && list.facets.blocked > 0 && (
                        <span className="numeric text-[color:var(--color-wrong)]">
                            （{list.facets.blocked}）
                        </span>
                    )}
                </label>

                {batch && (
                    <div className="flex items-center gap-3">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void withdrawBatch(batch, list?.facets.batch[batch] ?? 0)}
                        >
                            整批撤回这个批次
                        </Button>
                        <span className="text-xs text-ink-faint">导错一整份材料时用它，比一条条删快</span>
                    </div>
                )}
                <div className="flex items-center gap-3">
                    <Button size="sm" variant="ghost" onClick={() => void reclassify()}>
                        重新归类答案类型
                    </Button>
                    <span className="text-xs text-ink-faint">
                        抽取时模型标的类型常有错；标成"解答步骤"的题不判对错、也不计掌握度
                    </span>
                </div>
                {notice && <p className="text-xs text-[color:var(--color-correct)]">{notice}</p>}
            </div>

            {busy && !list ? (
                <LoadingState text="读取题库…" />
            ) : (
                <div className="space-y-2">
                    {list?.items.length === 0 && (
                        <p className="text-center text-sm text-ink-faint py-6">没有符合条件的题</p>
                    )}
                    {list?.items.map((q) => (
                        <div key={q.id} className="plate p-4 space-y-2">
                            <div className="flex items-start justify-between gap-3">
                                <p className="stem !text-base flex-1 whitespace-pre-wrap">{q.stem}</p>
                                <div className="flex gap-1.5 shrink-0">
                                    <Button size="sm" variant="ghost" onClick={() => setEditing(q)}>
                                        编辑
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => void removeOne(q)}>
                                        删除
                                    </Button>
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
                                <span>
                                    答案 <span className="numeric text-ink-soft font-semibold">{q.answer}</span>
                                </span>
                                <span>{LEVEL_LABEL[q.level] ?? q.level}</span>
                                <span>难度 <span className="numeric">{q.difficulty}</span></span>
                                <span className={q.status === 'extracted' ? 'text-[color:var(--color-wrong)]' : ''}>
                                    {STATUS_LABEL[q.status] ?? q.status}
                                </span>
                                {q.answerUnverified && q.status !== 'verified' && (
                                    <span className="text-[color:var(--color-wrong)]">
                                        答案是模型自己算的 · 暂不发给孩子
                                    </span>
                                )}
                                {q.figureImage || q.figure ? <span className="text-[color:var(--color-correct)]">带配图</span> : null}
                                <span>批次 {q.batch}</span>
                            </div>
                            {/* 入库之后同样要能看图：当初抽检看漏了、或题干后来改过，
                                只有把图摆出来才发现得了。原图优先 */}
                            {q.figureImage ? (
                                <div className="rounded-[10px] border border-rule bg-plate/40 p-3 space-y-2">
                                    <QuestionImage name={q.figureImage} />
                                    {q.analysisImage && (
                                        <>
                                            <p className="eyebrow text-center">
                                                讲义解析里的解法图 · 只在讲解时出现
                                            </p>
                                            <QuestionImage name={q.analysisImage} alt="解法图" />
                                        </>
                                    )}
                                </div>
                            ) : q.figure ? (
                                <div className="rounded-[10px] border border-rule bg-plate/40 p-3">
                                    <QuestionFigure figure={q.figure as FigureSpec} width={320} />
                                </div>
                            ) : null}
                            {q.nodeIds.length > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                    {q.nodeIds.map((n) => (
                                        <span key={n} className="rounded-md border border-beam/20 bg-beam-wash px-2 py-0.5 text-xs text-beam">
                                            {n}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {editing && (
                <EditDialog
                    question={editing}
                    onClose={() => setEditing(null)}
                    onSaved={(msg) => {
                        setEditing(null)
                        setNotice(msg)
                        void load()
                    }}
                />
            )}
        </div>
    )
}

/** 编辑框：字段少而关键，改完立刻走服务端校验 */
function EditDialog({
    question,
    onClose,
    onSaved,
}: {
    question: BankQuestion
    onClose: () => void
    onSaved: (msg: string) => void
}) {
    const [stem, setStem] = useState(question.stem)
    const [answer, setAnswer] = useState(question.answer)
    const [difficulty, setDifficulty] = useState(question.difficulty)
    const [nodeIds, setNodeIds] = useState(question.nodeIds.join(', '))
    const [analysis, setAnalysis] = useState(question.analysis ?? '')
    const [status, setStatus] = useState(question.status)
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    const save = async () => {
        setSaving(true)
        setError(null)
        try {
            const ids = nodeIds.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
            const res = await fetch(`/api/v1/bank/questions/${encodeURIComponent(question.id)}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    stem,
                    answer,
                    difficulty,
                    analysis: analysis || undefined,
                    status,
                    ...(ids.length ? { nodeIds: ids } : {}),
                }),
            })
            const body = (await res.json()) as { error?: string; figureNote?: string }
            if (!res.ok) {
                setError(body.error ?? `HTTP ${res.status}`)
                return
            }
            // 改了题干时配图可能因此对不上而被丢弃——必须让人知道
            onSaved(body.figureNote ? `已保存（${body.figureNote}）` : '已保存')
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-ink/30 flex items-start justify-center overflow-y-auto p-4">
            <div className="plate w-full max-w-2xl p-6 space-y-4 mt-8">
                <h3 className="text-section">编辑题目</h3>
                <Field label="题干">
                    <textarea className="input-hero !text-base resize-y" rows={3} value={stem} onChange={(e) => setStem(e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="答案">
                        <input className="input-hero !text-base !py-2" value={answer} onChange={(e) => setAnswer(e.target.value)} />
                    </Field>
                    <Field label="难度 1-5">
                        <input
                            type="number" min={1} max={5}
                            className="input-hero !text-base !py-2"
                            value={difficulty}
                            onChange={(e) => setDifficulty(Number(e.target.value))}
                        />
                    </Field>
                </div>
                <Field label="知识点 id（逗号分隔；图谱里没有的会被拒绝）">
                    <input className="input-hero !text-base !py-2" value={nodeIds} onChange={(e) => setNodeIds(e.target.value)} />
                </Field>
                <Field label="解析">
                    <textarea className="input-hero !text-base resize-y" rows={2} value={analysis} onChange={(e) => setAnalysis(e.target.value)} />
                </Field>
                <Field label="状态">
                    <select
                        className="w-full rounded-[10px] border border-rule bg-plate px-3 py-2 text-sm text-ink"
                        value={status}
                        onChange={(e) => setStatus(e.target.value)}
                    >
                        <option value="extracted">待抽检</option>
                        <option value="verified">已核对</option>
                    </select>
                </Field>
                {error && <p className="text-sm text-[color:var(--color-wrong)]">{error}</p>}
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={onClose}>取消</Button>
                    <Button onClick={() => void save()} disabled={saving}>
                        {saving ? '保存中…' : '保存'}
                    </Button>
                </div>
            </div>
        </div>
    )
}
