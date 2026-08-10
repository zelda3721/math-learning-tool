/**
 * LiveResult — 跑完之后的成片 + 小结 + Manim 代码，数据来自实时 AgentRunState。
 */
import { Play } from 'lucide-react'

import type { AgentRunState } from '../types/agent'
import { Button, MathText } from '../ui'

interface LiveResultProps {
    state: AgentRunState
    onReset?: () => void
}

export function LiveResult({ state, onReset }: LiveResultProps) {
    if (state.status === 'idle' || state.status === 'running') return null

    const code = extractManimCode(state)
    const video = state.finalVideoUrl

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                <div className={`plate p-3 ${code ? 'md:col-span-8' : 'md:col-span-12'}`}>
                    {video ? (
                        <video src={video} controls className="w-full rounded-[10px] bg-ink">
                            {state.subtitleUrl && (
                                <track kind="captions" src={state.subtitleUrl} srcLang="zh" label="中文讲解" />
                            )}
                        </video>
                    ) : (
                        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                            <span className="w-12 h-12 rounded-full border border-rule bg-paper flex items-center justify-center text-ink-faint">
                                <Play size={20} className="ml-0.5" />
                            </span>
                            <p className="text-sm text-ink-soft">未生成视频</p>
                            {state.error && <p className="text-xs text-wrong max-w-md">{state.error}</p>}
                        </div>
                    )}
                </div>

                {code && (
                    <div className="plate p-4 md:col-span-4 min-w-0">
                        <p className="eyebrow mb-2">生成的 Manim 代码</p>
                        <pre className="text-[11px] leading-relaxed text-ink-soft bg-paper border border-rule rounded-[10px] p-3 overflow-auto max-h-72 whitespace-pre-wrap">
                            {code}
                        </pre>
                    </div>
                )}
            </div>

            {state.finalText.trim() && (
                <div className="plate border-l-[3px] border-l-beam p-5">
                    <p className="eyebrow mb-2">小结</p>
                    <p className="text-ink leading-relaxed">
                        <MathText>{state.finalText}</MathText>
                    </p>
                </div>
            )}

            {onReset && (
                <div className="flex justify-end">
                    <Button variant="secondary" size="sm" onClick={onReset}>
                        出新一题
                    </Button>
                </div>
            )}
        </div>
    )
}

function extractManimCode(state: AgentRunState): string | null {
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
        const item = state.items[i]
        if (item.kind !== 'tool') continue
        if (!['generate_manim_code', 'compile_video'].includes(item.name)) continue
        const data = item.data
        if (data && typeof data['code'] === 'string') return data['code'] as string
    }
    return null
}
