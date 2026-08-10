/**
 * 「探索」页（P5）：孩子和探索伙伴（苏格拉底式 Agent）自由漫游星图。
 *  - 选节点：掌握中（glow/lit）的节点下拉 + 全图搜索框（离线子串匹配）；
 *    也可由星图 mathtutor:atlas-focus 事件带入。
 *  - 聊天：POST /api/v1/explore/chat，toolTrace 以小字「查了：xxx」展示。
 *  - 「✍️ 记下我的发现」→ POST /api/v1/notes；下方列出我的研究笔记。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLearner } from '../learner/LearnerContext'
import { LearnerGate, LearnerSwitcher } from '../practice/LearnerGate'
import { Button, Card, MathText, PageHeader } from '../ui'

interface AtlasNodeLite {
    id: string
    name: string
    stage: string
    keywords?: string[]
}

interface MasteryEntry {
    band: 'dim' | 'glow' | 'lit'
}

interface ChatTurn {
    role: 'user' | 'assistant'
    content: string
    /** assistant 回合的工具足迹（「查了：xxx」小字） */
    toolTrace?: { name: string; summary: string }[]
}

interface ResearchNote {
    slug: string
    title: string
    nodeId: string
    created: string
    contentMd: string
}

async function fetchAtlasNodes(
    learnerId: string
): Promise<{ nodes: AtlasNodeLite[]; mastery: Record<string, MasteryEntry> }> {
    const res = await fetch(`/api/v1/atlas?learnerId=${encodeURIComponent(learnerId)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as {
        graph?: { nodes?: AtlasNodeLite[] }
        mastery?: Record<string, MasteryEntry>
    }
    return { nodes: body.graph?.nodes ?? [], mastery: body.mastery ?? {} }
}

async function fetchNotes(learnerId: string): Promise<ResearchNote[]> {
    const res = await fetch(`/api/v1/notes?learnerId=${encodeURIComponent(learnerId)}`)
    if (!res.ok) return []
    const body = (await res.json()) as { notes?: ResearchNote[] }
    return body.notes ?? []
}

export function ExplorePage() {
    const { learner } = useLearner()
    const learnerId = learner?.id

    const [nodes, setNodes] = useState<AtlasNodeLite[]>([])
    const [mastery, setMastery] = useState<Record<string, MasteryEntry>>({})
    const [nodeId, setNodeId] = useState<string>('')
    const [search, setSearch] = useState('')

    const [turns, setTurns] = useState<ChatTurn[]>([])
    const [input, setInput] = useState('')
    const [sending, setSending] = useState(false)
    const [chatError, setChatError] = useState<string | null>(null)

    const [noteOpen, setNoteOpen] = useState(false)
    const [noteTitle, setNoteTitle] = useState('')
    const [noteContent, setNoteContent] = useState('')
    const [noteSaving, setNoteSaving] = useState(false)
    const [noteNotice, setNoteNotice] = useState<string | null>(null)
    const [notes, setNotes] = useState<ResearchNote[]>([])

    const chatEndRef = useRef<HTMLDivElement | null>(null)

    // 图谱节点 + 掌握度
    useEffect(() => {
        if (!learnerId) return
        let cancelled = false
        fetchAtlasNodes(learnerId)
            .then((d) => {
                if (cancelled) return
                setNodes(d.nodes)
                setMastery(d.mastery)
            })
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [learnerId])

    // 我的研究笔记
    const reloadNotes = useCallback(() => {
        if (!learnerId) return
        void fetchNotes(learnerId).then(setNotes)
    }, [learnerId])
    useEffect(() => {
        reloadNotes()
    }, [reloadNotes])

    // 星图「去探索」入口：atlas-focus 事件带入节点
    useEffect(() => {
        const onFocus = (e: Event) => {
            const id = (e as CustomEvent<{ nodeId?: string }>).detail?.nodeId
            if (id) setNodeId(id)
        }
        window.addEventListener('mathtutor:atlas-focus', onFocus)
        return () => window.removeEventListener('mathtutor:atlas-focus', onFocus)
    }, [])

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }, [turns, sending])

    const nameOf = useMemo(() => new Map(nodes.map((n) => [n.id, n.name])), [nodes])

    /** 下拉：掌握中（glow/lit）的节点是探索首选 */
    const litNodes = useMemo(
        () => nodes.filter((n) => mastery[n.id]?.band === 'glow' || mastery[n.id]?.band === 'lit'),
        [nodes, mastery]
    )

    /** 搜索框：全图离线子串匹配（名称/关键词） */
    const searchHits = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (!q) return []
        return nodes
            .filter(
                (n) =>
                    n.name.toLowerCase().includes(q) ||
                    (n.keywords ?? []).some((k) => k.toLowerCase().includes(q))
            )
            .slice(0, 8)
    }, [nodes, search])

    const send = useCallback(async () => {
        const content = input.trim()
        if (!content || sending || !learnerId) return
        const history = turns.map((t) => ({ role: t.role, content: t.content }))
        setTurns((prev) => [...prev, { role: 'user', content }])
        setInput('')
        setSending(true)
        setChatError(null)
        try {
            const res = await fetch('/api/v1/explore/chat', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    learnerId,
                    nodeId: nodeId || undefined,
                    messages: [...history, { role: 'user', content }],
                }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const body = (await res.json()) as {
                reply: string
                toolTrace?: { name: string; summary: string }[]
            }
            setTurns((prev) => [
                ...prev,
                { role: 'assistant', content: body.reply, toolTrace: body.toolTrace },
            ])
        } catch (err) {
            setChatError(err instanceof Error ? err.message : String(err))
        } finally {
            setSending(false)
        }
    }, [input, sending, learnerId, nodeId, turns])

    /** 预填对话最后一轮（我的问题 + 伙伴的回应） */
    const openNoteComposer = () => {
        const lastUser = [...turns].reverse().find((t) => t.role === 'user')
        const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
        const prefill = [
            lastUser ? `我问：${lastUser.content}` : '',
            lastAssistant ? `伙伴说：${lastAssistant.content}` : '',
            '',
            '我的发现：',
        ]
            .filter((l, i) => l !== '' || i >= 2)
            .join('\n')
        setNoteTitle(nodeId ? `关于「${nameOf.get(nodeId) ?? nodeId}」的发现` : '我的探索发现')
        setNoteContent(prefill)
        setNoteOpen(true)
    }

    const saveNote = async () => {
        if (!learnerId || !nodeId || noteSaving) return
        const title = noteTitle.trim()
        const contentMd = noteContent.trim()
        if (!title || !contentMd) return
        setNoteSaving(true)
        try {
            const res = await fetch('/api/v1/notes', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId, nodeId, title, contentMd }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setNoteOpen(false)
            setNoteNotice('已记下！好的发现值得被记住。')
            setTimeout(() => setNoteNotice(null), 4000)
            reloadNotes()
        } catch (err) {
            setNoteNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`)
        } finally {
            setNoteSaving(false)
        }
    }

    if (!learner) return <LearnerGate />

    return (
        <div className="space-y-4">
            <PageHeader
                title="数学探索"
                subtitle="挑一个知识点，跟着问题往深处走——答案要自己想出来"
            />
            <LearnerSwitcher />

            {/* 选节点：掌握中的节点下拉 + 全图搜索 */}
            <div className="plate p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                    <label className="eyebrow" htmlFor="explore-node">
                        探索的知识点
                    </label>
                    <select
                        id="explore-node"
                        value={litNodes.some((n) => n.id === nodeId) ? nodeId : ''}
                        onChange={(e) => setNodeId(e.target.value)}
                        className="rounded-[10px] border border-rule bg-plate px-3 py-1.5 text-sm text-ink"
                    >
                        <option value="">（不指定）</option>
                        {litNodes.map((n) => (
                            <option key={n.id} value={n.id}>
                                {n.name}
                                {mastery[n.id]?.band === 'lit' ? ' ✦' : ''}
                            </option>
                        ))}
                    </select>
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="搜索全部知识点…"
                        className="flex-1 min-w-[160px] rounded-[10px] border border-rule bg-plate px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint"
                    />
                </div>
                {searchHits.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {searchHits.map((n) => (
                            <button
                                key={n.id}
                                type="button"
                                onClick={() => {
                                    setNodeId(n.id)
                                    setSearch('')
                                }}
                                className="rounded-[10px] border border-rule bg-plate px-2.5 py-1 text-xs text-ink-soft hover:border-beam hover:text-beam transition-colors"
                            >
                                {n.name}
                            </button>
                        ))}
                    </div>
                )}
                {nodeId && (
                    <p className="text-xs text-ink-faint">
                        正在探索：
                        <span className="font-semibold text-beam">{nameOf.get(nodeId) ?? nodeId}</span>
                        <button
                            type="button"
                            onClick={() => setNodeId('')}
                            className="ml-2 text-ink-faint hover:text-ink underline"
                        >
                            清除
                        </button>
                    </p>
                )}
            </div>

            {/* 聊天区 */}
            <div className="plate p-4 space-y-3">
                <div className="max-h-[46vh] overflow-y-auto space-y-3 pr-1">
                    {turns.length === 0 && (
                        <p className="text-center text-ink-faint text-sm py-8">
                            问点什么吧——比如「这个知识点将来会长成什么？」
                        </p>
                    )}
                    {turns.map((t, i) => (
                        <div key={i} className={t.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                            <div
                                className={
                                    t.role === 'user'
                                        ? 'max-w-[85%] rounded-[14px] rounded-br-[4px] bg-beam text-white px-4 py-2.5 text-sm whitespace-pre-wrap'
                                        : 'max-w-[85%] plate px-4 py-2.5 text-sm text-ink whitespace-pre-wrap'
                                }
                            >
                                <MathText>{t.content}</MathText>
                                {t.role === 'assistant' && (t.toolTrace?.length ?? 0) > 0 && (
                                    <div className="mt-2 space-y-0.5 border-t border-rule pt-2">
                                        {t.toolTrace!.map((tt, j) => (
                                            <div key={j} className="eyebrow">
                                                查了：{tt.summary}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    {sending && <p className="text-sm text-ink-faint px-1">伙伴正在想…</p>}
                    {chatError && <p className="text-sm text-wrong px-1">出错了：{chatError}</p>}
                    <div ref={chatEndRef} />
                </div>

                <form
                    onSubmit={(e) => {
                        e.preventDefault()
                        void send()
                    }}
                    className="flex gap-2"
                >
                    <input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="说说你的好奇…"
                        className="input-hero flex-1 min-w-0"
                    />
                    <Button type="submit" disabled={sending || !input.trim()}>
                        发送
                    </Button>
                </form>

                <div className="flex items-center gap-3">
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={openNoteComposer}
                        disabled={turns.length === 0 || !nodeId}
                        title={!nodeId ? '先选一个知识点再记笔记' : undefined}
                    >
                        ✍️ 记下我的发现
                    </Button>
                    {!nodeId && turns.length > 0 && (
                        <span className="text-xs text-ink-faint">先在上面选一个知识点，就能记笔记啦</span>
                    )}
                    {noteNotice && (
                        <span className="text-xs font-semibold text-[var(--color-correct)]">{noteNotice}</span>
                    )}
                </div>
            </div>

            {/* 记笔记弹层（简单内联卡片） */}
            {noteOpen && (
                <div className="plate p-5 space-y-3">
                    <h3 className="text-section">记下我的发现</h3>
                    <input
                        value={noteTitle}
                        onChange={(e) => setNoteTitle(e.target.value)}
                        placeholder="给发现起个标题"
                        className="w-full rounded-[10px] border border-rule bg-plate px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
                    />
                    <textarea
                        value={noteContent}
                        onChange={(e) => setNoteContent(e.target.value)}
                        rows={6}
                        className="numeric w-full rounded-[10px] border border-rule bg-plate px-3 py-2 text-sm text-ink"
                    />
                    <div className="flex gap-2">
                        <Button
                            size="sm"
                            onClick={() => void saveNote()}
                            disabled={noteSaving || !noteTitle.trim() || !noteContent.trim()}
                        >
                            {noteSaving ? '保存中…' : '保存笔记'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setNoteOpen(false)}>
                            取消
                        </Button>
                    </div>
                </div>
            )}

            {/* 我的研究笔记 */}
            <div className="space-y-2">
                <h3 className="eyebrow px-1 pt-3">我的研究笔记</h3>
                {notes.length === 0 && (
                    <p className="text-sm text-ink-faint px-1">还没有笔记——探索中记下的发现会出现在这里。</p>
                )}
                {notes.map((n) => (
                    <Card key={n.slug}>
                        <details>
                            <summary className="cursor-pointer select-none">
                                <span className="font-semibold text-ink">{n.title}</span>
                                <span className="ml-2 text-xs text-ink-faint">
                                    {nameOf.get(n.nodeId) ?? n.nodeId}
                                    {n.created ? (
                                        <span className="numeric">
                                            {` · ${new Date(n.created).toLocaleDateString('zh-CN')}`}
                                        </span>
                                    ) : (
                                        ''
                                    )}
                                </span>
                            </summary>
                            <pre className="mt-3 whitespace-pre-wrap text-sm text-ink-soft font-sans leading-relaxed">
                                {n.contentMd}
                            </pre>
                        </details>
                    </Card>
                ))}
            </div>
        </div>
    )
}
