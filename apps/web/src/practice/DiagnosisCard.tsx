import type { DiagnosisResult } from './api'
import { MathText } from '../ui/MathText'

/** 置信度文案：不给小孩看裸百分比（宪法第 4 条：归因必须带置信度） */
export function confidenceText(confidence: number): string {
    if (confidence >= 0.7) return '基本确定'
    if (confidence >= 0.45) return '比较可能'
    return '初步猜测'
}

function confidenceCls(confidence: number): string {
    if (confidence >= 0.7) return 'bg-emerald-100 text-emerald-700 border-emerald-200'
    if (confidence >= 0.45) return 'bg-amber-100 text-amber-700 border-amber-200'
    return 'bg-slate-100 text-slate-500 border-slate-200'
}

export function ConfidenceBadge({ confidence }: { confidence: number }) {
    return (
        <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${confidenceCls(confidence)}`}
        >
            {confidenceText(confidence)}
        </span>
    )
}

interface Props {
    diagnosis: DiagnosisResult
    onExplain: () => void
    onVariant: () => void
}

/** 归因卡：根因大字 + 置信度文案 + 依据链 + 常见坑 + 探针提示，两条出路（讲解/变式）。 */
export function DiagnosisCard({ diagnosis, onExplain, onVariant }: Props) {
    return (
        <div className="space-y-5">
            <div className="text-center space-y-2">
                <p className="text-sm font-semibold text-slate-400">这道题卡住的地方可能是</p>
                <h3 className="text-2xl md:text-3xl font-bold text-indigo-600">
                    {diagnosis.rootNodeName}
                </h3>
                <ConfidenceBadge confidence={diagnosis.confidence} />
            </div>

            {diagnosis.chainNames.length > 0 && (
                <div className="rounded-2xl bg-indigo-50/60 border border-indigo-100 px-4 py-3">
                    <p className="text-xs font-bold text-indigo-400 mb-1">依据链</p>
                    <p className="text-sm text-indigo-700 leading-relaxed">
                        {diagnosis.chainNames.join(' → ')}
                    </p>
                </div>
            )}

            {diagnosis.misconceptionDesc && (
                <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3">
                    <p className="text-xs font-bold text-amber-500 mb-1">常见的坑</p>
                    <p className="text-amber-800 whitespace-pre-wrap">{diagnosis.misconceptionDesc}</p>
                </div>
            )}

            {diagnosis.explanation && (
                <p className="text-sm text-slate-500 leading-relaxed whitespace-pre-wrap">
                    <MathText>{diagnosis.explanation}</MathText>
                </p>
            )}

            {!diagnosis.eligible && (
                <div className="rounded-2xl bg-sky-50 border border-sky-200 px-4 py-2.5 text-sm text-sky-700 font-medium">
                    🔍 已安排探针题，明天的练习里确认
                </div>
            )}

            <div className="flex flex-wrap justify-center gap-3 pt-1">
                <button
                    type="button"
                    onClick={onExplain}
                    className="px-8 py-3 rounded-2xl bg-sky-500 text-white text-lg font-bold shadow-lg shadow-sky-200 hover:bg-sky-600 transition-colors"
                >
                    看讲解
                </button>
                <button
                    type="button"
                    onClick={onVariant}
                    className="px-8 py-3 rounded-2xl bg-violet-500 text-white text-lg font-bold shadow-lg shadow-violet-200 hover:bg-violet-600 transition-colors"
                >
                    做一道变式题
                </button>
            </div>
        </div>
    )
}
