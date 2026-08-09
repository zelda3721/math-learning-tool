import { useEffect, useMemo, useState } from 'react'
import {
    fetchMistakes,
    fetchNodeNames,
    type ExplainRequest,
    type MasteryBand,
    type MistakeSummary,
} from './api'
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
        // App.tsx 不在本模块修改范围内：先派事件（未来 App 可监听），同时给出可操作提示。
        window.dispatchEvent(new CustomEvent('mathtutor:navigate', { detail: { view: 'atlas' } }))
        setAtlasTip(true)
    }

    return (
        <div className="soft-glass p-8 max-w-xl mx-auto space-y-6 text-center">
            <h2 className="text-2xl font-bold text-slate-700">今日练习完成!</h2>

            <div className="grid grid-cols-3 gap-3">
                <div className="rounded-2xl bg-emerald-50 border border-emerald-100 py-4">
                    <div className="text-3xl font-bold text-emerald-500">{correct}</div>
                    <div className="text-sm text-slate-500 mt-1">答对</div>
                </div>
                <div className="rounded-2xl bg-red-50 border border-red-100 py-4">
                    <div className="text-3xl font-bold text-red-400">{wrong}</div>
                    <div className="text-sm text-slate-500 mt-1">没对</div>
                </div>
                <div className="rounded-2xl bg-amber-50 border border-amber-100 py-4">
                    <div className="text-3xl font-bold text-amber-500">{hintsUsed}</div>
                    <div className="text-sm text-slate-500 mt-1">用提示</div>
                </div>
            </div>
            {review > 0 && (
                <p className="text-sm text-slate-500">另有 {review} 题已交给家长确认。</p>
            )}
            {variantLit > 0 && (
                <p className="text-sm text-emerald-600 font-medium">
                    ⭐ 其中 {variantLit} 题通过变式题重新点亮！
                </p>
            )}

            {wrongRecords.length > 0 && (
                <div className="text-left space-y-2">
                    <h3 className="text-sm font-semibold text-slate-500 text-center">错题回顾</h3>
                    <ul className="space-y-2">
                        {wrongRecords.map(({ record, mistake }, i) => (
                            <li
                                key={`${record.questionId}-${i}`}
                                className="rounded-2xl bg-white/70 border border-slate-100 px-4 py-3 space-y-1.5"
                            >
                                <p className="text-sm text-slate-600 line-clamp-2">
                                    {mistake?.questionStem ?? record.questionId}
                                </p>
                                <div className="flex items-center justify-between gap-3">
                                    {mistake ? (
                                        <span className="text-sm min-w-0 truncate">
                                            <span className="font-semibold text-indigo-600">
                                                {mistake.rootNodeName}
                                            </span>
                                            <span className="text-slate-400 ml-2">
                                                {confidenceText(mistake.confidence)}
                                            </span>
                                        </span>
                                    ) : (
                                        <span className="text-sm text-slate-400">还没归因</span>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setExplainReq({
                                                learnerId,
                                                questionId: record.questionId,
                                                mistakeId: mistake?.id,
                                                focusNodeId: mistake?.rootNodeId,
                                                misconceptionId: mistake?.misconceptionId,
                                            })
                                        }
                                        className="shrink-0 px-3 py-1.5 rounded-xl bg-sky-100 text-sky-600 text-xs font-bold hover:bg-sky-200 transition-colors"
                                    >
                                        再看讲解
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {nodeChanges.length > 0 && (
                <div className="text-left space-y-2">
                    <h3 className="text-sm font-semibold text-slate-500 text-center">知识点亮度变化</h3>
                    <ul className="space-y-2">
                        {nodeChanges.map((c) => (
                            <li
                                key={c.nodeId}
                                className="flex items-center justify-between gap-3 rounded-2xl bg-white/70 border border-slate-100 px-4 py-2.5"
                            >
                                <span className="text-slate-700 font-medium truncate">
                                    {nodeNames[c.nodeId] ?? c.nodeId}
                                </span>
                                <span className="flex items-center gap-1.5 shrink-0">
                                    {c.firstBand !== c.lastBand && (
                                        <>
                                            <BandBadge band={c.firstBand} />
                                            <span className="text-slate-300">→</span>
                                        </>
                                    )}
                                    <BandBadge band={c.lastBand} />
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="flex flex-wrap justify-center gap-3 pt-2">
                <button
                    type="button"
                    onClick={handleGoAtlas}
                    className="px-6 py-3 rounded-2xl bg-indigo-500 text-white font-bold shadow-lg shadow-indigo-200 hover:bg-indigo-600 transition-colors"
                >
                    去星图看看
                </button>
                <button
                    type="button"
                    onClick={onRestart}
                    className="px-6 py-3 rounded-2xl bg-white border-2 border-slate-100 text-slate-600 font-bold hover:border-sky-300 transition-colors"
                >
                    再练一组
                </button>
            </div>
            {atlasTip && (
                <p className="text-sm text-sky-600">点击页面上方的「星图」标签，看看哪些星星亮起来了。</p>
            )}

            {/* 再看讲解：浮层复用 ExplanationView，key 保证换题时重新请求 */}
            {explainReq && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
                    <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-3xl bg-white p-6 text-left shadow-2xl">
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
