import type { DiagnosisResult } from './api'
import { Badge, Button, MathText, type BadgeTone } from '../ui'

/** 置信度文案：不给小孩看裸百分比（宪法第 4 条：归因必须带置信度） */
export function confidenceText(confidence: number): string {
    if (confidence >= 0.7) return '基本确定'
    if (confidence >= 0.45) return '比较可能'
    return '初步猜测'
}

function confidenceTone(confidence: number): BadgeTone {
    if (confidence >= 0.7) return 'correct'
    if (confidence >= 0.45) return 'beam'
    return 'slate'
}

export function ConfidenceBadge({ confidence }: { confidence: number }) {
    return <Badge tone={confidenceTone(confidence)}>{confidenceText(confidence)}</Badge>
}

interface Props {
    diagnosis: DiagnosisResult
    onExplain: () => void
    onVariant: () => void
}

/** 归因卡：根因大字 + 置信度文案 + 依据链面包屑 + 常见坑 + 探针提示，两条出路（讲解/变式）。
 *  色彩纪律：根因是「诊断结论」不是「学会了」——用墨色加粗 + beam 徽章，金色留给点亮时刻。 */
export function DiagnosisCard({ diagnosis, onExplain, onVariant }: Props) {
    return (
        <div className="space-y-5">
            <div className="text-center space-y-2">
                <p className="eyebrow">这道题卡住的地方可能是</p>
                <h3 className="text-2xl md:text-3xl font-bold text-ink tracking-tight">
                    {diagnosis.rootNodeName}
                </h3>
                <div className="flex flex-wrap items-center justify-center gap-2">
                    <Badge tone="beam">根因</Badge>
                    <ConfidenceBadge confidence={diagnosis.confidence} />
                </div>
            </div>

            {diagnosis.chainNames.length > 0 && (
                <div className="rounded-[10px] bg-paper border border-rule px-4 py-3">
                    <p className="eyebrow mb-1.5">依据链</p>
                    <p className="text-sm leading-relaxed">
                        {diagnosis.chainNames.map((name, i) => (
                            <span key={`${name}-${i}`}>
                                {i > 0 && <span className="text-ink-faint mx-1.5">→</span>}
                                <span
                                    className={
                                        i === diagnosis.chainNames.length - 1
                                            ? 'text-ink font-semibold'
                                            : 'text-ink-soft'
                                    }
                                >
                                    {name}
                                </span>
                            </span>
                        ))}
                    </p>
                </div>
            )}

            {diagnosis.misconceptionDesc && (
                <div className="rounded-[10px] bg-wrong-wash border border-wrong/20 px-4 py-3">
                    <p className="eyebrow mb-1.5">常见的坑</p>
                    <p className="text-ink-soft leading-relaxed whitespace-pre-wrap">
                        {diagnosis.misconceptionDesc}
                    </p>
                </div>
            )}

            {diagnosis.explanation && (
                <p className="text-sm text-ink-soft leading-relaxed whitespace-pre-wrap">
                    <MathText>{diagnosis.explanation}</MathText>
                </p>
            )}

            {!diagnosis.eligible && (
                <div className="rounded-[10px] bg-beam-wash border border-beam/20 px-4 py-2.5 text-sm text-beam font-medium">
                    🔍 已安排探针题，明天的练习里确认
                </div>
            )}

            <div className="flex flex-wrap justify-center gap-3 pt-1">
                <Button size="lg" onClick={onExplain}>
                    看讲解
                </Button>
                <Button size="lg" variant="secondary" onClick={onVariant}>
                    做一道变式题
                </Button>
            </div>
        </div>
    )
}
