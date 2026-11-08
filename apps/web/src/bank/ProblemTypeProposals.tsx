import { useCallback, useEffect, useState } from 'react'

import { Badge, Button } from '../ui'

/**
 * 题型提案（P2）：只报不改，人看过才算。
 *
 * 题型不是知识点：知识点是大纲的骨架，题型是它在具体情境下的变体。
 * 挂上题型，讲解才拿得到"这类题的本质是什么"；挂错，孩子会学到另一类题的方法。
 * 所以这里把**分数、分差、命中的词**都摆出来，高置信的一键采纳，其余逐条看。
 */

interface Proposal {
    questionId: string
    stem: string
    level: string
    proposed: string
    proposedName: string
    score: number
    margin: number
    reasons: string[]
    alternatives: { id: string; name: string; score: number }[]
    confidence: 'high' | 'medium' | 'low'
}

const CONFIDENCE_META: Record<Proposal['confidence'], { label: string; tone: 'beam' | 'slate' | 'wrong' }> = {
    high: { label: '高置信', tone: 'beam' },
    medium: { label: '再看看', tone: 'slate' },
    low: { label: '很弱', tone: 'wrong' },
}

export function ProblemTypeProposals({ onApplied }: { onApplied?: () => void }) {
    const [proposals, setProposals] = useState<Proposal[] | null>(null)
    const [counts, setCounts] = useState<{ high: number; medium: number; low: number } | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            const res = await fetch('/api/v1/bank/problem-type-proposals?include=all')
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as {
                counts: { high: number; medium: number; low: number }
                proposals: Proposal[]
            }
            setProposals(data.proposals)
            setCounts(data.counts)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    const apply = async (ids: string[]) => {
        if (!ids.length || busy) return
        setBusy(true)
        setError(null)
        try {
            const res = await fetch('/api/v1/bank/problem-type-proposals/apply', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as { applied: number }
            setNotice(`采纳了 ${data.applied} 道题的题型，已写回题库文件`)
            await load()
            onApplied?.()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    if (error) {
        return (
            <div className="rounded-[10px] border border-rule bg-paper p-3 text-sm text-wrong">
                题型提案加载失败：{error}
                <Button size="sm" variant="ghost" onClick={() => void load()}>
                    重试
                </Button>
            </div>
        )
    }

    if (!proposals) return null
    if (proposals.length === 0) {
        return (
            <div className="rounded-[10px] border border-rule bg-paper p-3">
                <p className="eyebrow">题型提案</p>
                <p className="text-sm text-ink-faint mt-1">
                    没有可提的了——要么都挂上了，要么题干和题库里的题型对不上（这两条闸就是为了宁可漏、不错挂）。
                </p>
            </div>
        )
    }

    const highIds = proposals.filter((p) => p.confidence === 'high').map((p) => p.questionId)

    return (
        <div className="rounded-[10px] border border-rule bg-paper p-3 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="eyebrow">题型提案（只报不改）</p>
                <span className="text-xs text-ink-faint numeric">
                    {counts ? `高置信 ${counts.high} · 再看看 ${counts.medium} · 很弱 ${counts.low}` : ''}
                </span>
            </div>
            <p className="text-xs text-ink-faint">
                两条闸：本学段 + 题型声明的知识点要对得上。分数越高、和第二名差得越多越可信；命中的词摆在那儿，看一眼就知道靠不靠谱。
            </p>
            {highIds.length > 0 && (
                <Button size="sm" disabled={busy} onClick={() => void apply(highIds)}>
                    采纳全部高置信（{highIds.length}）
                </Button>
            )}
            {notice && <p className="text-xs text-[color:var(--color-correct)]">{notice}</p>}
            <ul className="space-y-2 max-h-[420px] overflow-auto pr-1">
                {proposals.slice(0, 60).map((p) => (
                    <li key={p.questionId} className="rounded-[10px] border border-rule bg-plate px-3 py-2 space-y-1">
                        <div className="flex items-center gap-2">
                            <Badge tone={CONFIDENCE_META[p.confidence].tone}>{CONFIDENCE_META[p.confidence].label}</Badge>
                            <span className="text-sm font-semibold text-ink">{p.proposedName}</span>
                            <span className="text-xs text-ink-faint numeric">
                                {p.score} 分 · 领先 {p.margin === 999 ? '无对手' : `${p.margin}×`}
                            </span>
                        </div>
                        <p className="text-xs text-ink-soft line-clamp-2">{p.stem}</p>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
                            <span>命中：{p.reasons.join('、') || '（无关键词，仅骨架）'}</span>
                            {p.alternatives[0] && <span>次选：{p.alternatives[0].name}（{p.alternatives[0].score}）</span>}
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void apply([p.questionId])}>
                                采纳
                            </Button>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    )
}
