import { useEffect, useMemo, useState } from 'react'
import {
    fetchMistakes,
    fetchNodeNames,
    type ExplainRequest,
    type MasteryBand,
    type MistakeSummary,
} from './api'
import { useAuth } from '../auth/AuthContext'
import { Badge, Button, Lightline } from '../ui'
import type { QuestionRecord } from './QuestionCard'
import { BandBadge } from './badges'
import { confidenceText } from './DiagnosisCard'
import { ExplanationView } from './ExplanationView'

interface Props {
    records: QuestionRecord[]
    learnerId: string
    onRestart: () => void
}

interface NodeChange {
    nodeId: string
    firstBand: MasteryBand
    lastBand: MasteryBand
    lastP: number
}

export function SessionSummary({ records, learnerId, onRestart }: Props) {
    const { user } = useAuth()
    const isParent = user?.role === 'parent'
    const [nodeNames, setNodeNames] = useState<Record<string, string>>({})
    const [atlasTip, setAtlasTip] = useState(false)
    const [mistakes, setMistakes] = useState<MistakeSummary[]>([])
    const [explainReq, setExplainReq] = useState<ExplainRequest | null>(null)

    useEffect(() => {
        let cancelled = false
        void fetchNodeNames(learnerId).then((names) => {
            if (!cancelled) setNodeNames(names)
        })
        void fetchMistakes(learnerId).then((list) => {
            if (!cancelled) setMistakes(list)
        })
        return () => {
            cancelled = true
        }
    }, [learnerId])

    const total = records.length
    const correct = records.filter((r) => r.correct).length
    const review = records.filter((r) => r.review).length
    const wrong = total - correct - review
    const hintsUsed = records.reduce((sum, r) => sum + r.hintLevel, 0)
    const variantLit = records.filter((r) => r.variantCorrect === true).length

    // 错题（含跳过）× 最近一次归因坐标（mistakes 按时间倒序，find 即最新）
    const wrongRecords = useMemo(
        () =>
            records
                .filter((r) => !r.correct && !r.review)
                .map((r) => ({
                    record: r,
                    mistake: mistakes.find((m) => m.questionId === r.questionId),
                })),
        [records, mistakes]
    )

    const nodeChanges = useMemo<NodeChange[]>(() => {
        const map = new Map<string, NodeChange>()
        for (const record of records) {
            for (const change of record.mastery) {
                const existing = map.get(change.nodeId)
                if (existing) {
                    existing.lastBand = change.band
                    existing.lastP = change.p
                } else {
                    map.set(change.nodeId, {
                        nodeId: change.nodeId,
                        firstBand: change.band,
                        lastBand: change.band,
                        lastP: change.p,
                    })
                }
            }
        }
        return [...map.values()]
    }, [records])

    const handleGoAtlas = () => {
        // App 监听 mathtutor:navigate 完成切换；若因角色不可见而未切走，才提示手动点标签
        window.dispatchEvent(new CustomEvent('mathtutor:navigate', { detail: { view: 'atlas' } }))
        setTimeout(() => setAtlasTip(true), 400)
    }

    return (
        <div className="plate p-8 max-w-xl mx-auto space-y-6 text-center">
            <h2 className="text-2xl font-bold text-ink tracking-tight">今日练习完成!</h2>

            <div className="grid grid-cols-3 gap-3">
                <div className="rounded-[10px] bg-correct-wash border border-correct/20 py-4">
                    <div className="numeric text-3xl font-bold text-[var(--color-correct)]">{correct}</div>
                    <div className="eyebrow mt-1.5">答对</div>
                </div>
                <div className="rounded-[10px] bg-wrong-wash border border-wrong/20 py-4">
                    <div className="numeric text-3xl font-bold text-wrong">{wrong}</div>
                    <div className="eyebrow mt-1.5">没对</div>
                </div>
                <div className="rounded-[10px] bg-paper border border-rule py-4">
                    <div className="numeric text-3xl font-bold text-ink-soft">{hintsUsed}</div>
                    <div className="eyebrow mt-1.5">用提示</div>
                </div>
            </div>
            {review > 0 && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <p className="text-sm text-ink-soft">
                        另有 <span className="numeric">{review}</span> 题已交给家长确认。
                    </p>
                    {/* 家长在场时给一条直路。此前"交给家长"之后就没有下文了，
                        那几道题会一直悬着——判不准转人工是对的，转过去没人知道就不对了 */}
                    {isParent && (
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                                window.dispatchEvent(
                                    new CustomEvent('mathtutor:navigate', { detail: { view: 'parent' } }),
                                )
                            }
                        >
                            现在去批改
                        </Button>
                    )}
                </div>
            )}
            {variantLit > 0 && (
                <div className="flex justify-center">
                    <Badge tone="lit">
                        ⭐ 变式题重新点亮 <span className="numeric mx-1">{variantLit}</span> 题
                    </Badge>
                </div>
            )}

            {wrongRecords.length > 0 && (
                <div className="text-left space-y-2">
                    <h3 className="eyebrow text-center">错题回顾</h3>
                    <ul className="space-y-2">
                        {wrongRecords.map(({ record, mistake }, i) => (
                            <li
                                key={`${record.questionId}-${i}`}
                                className="rounded-[10px] bg-paper border border-rule px-4 py-3 space-y-1.5"
                            >
                                <p className="text-sm text-ink-soft line-clamp-2">
                                    {mistake?.questionStem ?? record.questionId}
                                </p>
                                <div className="flex items-center justify-between gap-3">
                                    {mistake ? (
                                        <span className="text-sm min-w-0 truncate">
                                            <span className="font-semibold text-ink">
                                                {mistake.rootNodeName}
                                            </span>
                                            <span className="text-ink-faint ml-2">
                                                {confidenceText(mistake.confidence)}
                                            </span>
                                        </span>
                                    ) : (
                                        <span className="text-sm text-ink-faint">还没归因</span>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        className="shrink-0"
                                        onClick={() =>
                                            setExplainReq({
                                                learnerId,
                                                questionId: record.questionId,
                                                mistakeId: mistake?.id,
                                                focusNodeId: mistake?.rootNodeId,
                                                misconceptionId: mistake?.misconceptionId,
                                            })
                                        }
                                    >
                                        再看讲解
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {nodeChanges.length > 0 && (
                <div className="text-left space-y-2">
                    <h3 className="eyebrow text-center">知识点亮度变化</h3>
                    <ul className="space-y-2">
                        {nodeChanges.map((c) => (
                            <li
                                key={c.nodeId}
                                className="rounded-[10px] bg-paper border border-rule px-4 py-3 space-y-2"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-ink font-medium truncate">
                                        {nodeNames[c.nodeId] ?? c.nodeId}
                                    </span>
                                    <span className="flex items-center gap-1.5 shrink-0">
                                        {c.firstBand !== c.lastBand && (
                                            <>
                                                <BandBadge band={c.firstBand} />
                                                <span className="text-ink-faint">→</span>
                                            </>
                                        )}
                                        <BandBadge band={c.lastBand} />
                                    </span>
                                </div>
                                <div className="flex items-center gap-2.5">
                                    <div className="flex-1">
                                        <Lightline value={c.lastP} max={1} />
                                    </div>
                                    <span className="numeric text-xs text-ink-faint shrink-0">
                                        {Math.round(c.lastP * 100)}%
                                    </span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="flex flex-wrap justify-center gap-3 pt-2">
                <Button onClick={handleGoAtlas}>去星图看看</Button>
                <Button variant="secondary" onClick={onRestart}>
                    再练一组
                </Button>
            </div>
            {atlasTip && (
                <p className="text-sm text-beam">点击页面上方的「星图」标签，看看哪些星星亮起来了。</p>
            )}

            {/* 再看讲解：浮层复用 ExplanationView，key 保证换题时重新请求 */}
            {explainReq && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
                    <div className="plate w-full max-w-xl max-h-[90vh] overflow-y-auto p-6 text-left">
                        <ExplanationView
                            key={explainReq.questionId ?? explainReq.mistakeId ?? 'explain'}
                            request={explainReq}
                            primaryLabel="关闭"
                            onPrimary={() => setExplainReq(null)}
                        />
                    </div>
                </div>
            )}
        </div>
    )
}
