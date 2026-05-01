/**
 * LiveResult — final video + summary + manim code, derived from a live
 * AgentRunState. Shown after the agent finishes (done / exhausted / failed).
 */
import { CheckCircle2, FileCode2, Play, RotateCcw } from 'lucide-react'

import type { AgentRunState } from '../types/agent'

interface LiveResultProps {
    state: AgentRunState
    onReset?: () => void
}

export function LiveResult({ state, onReset }: LiveResultProps) {
    if (state.status === 'idle' || state.status === 'running') return null

    const code = extractManimCode(state)
    const video = state.finalVideoUrl

    return (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 animate-fade-in-up">
            <div
                className={`bento-card ${code ? 'md:col-span-8' : 'md:col-span-12'} min-h-[320px] bg-slate-900 border-none relative overflow-hidden group`}
            >
                {video ? (
                    <>
                        <video
                            src={video}
                            controls
                            className="w-full h-full object-contain rounded-xl z-10 relative"
                        />
                        <div className="absolute inset-0 bg-blue-500/20 blur-3xl group-hover:bg-blue-500/30 transition-all duration-500" />
                    </>
                ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 gap-4 py-12">
                        <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center">
                            <Play size={24} className="ml-1 text-slate-600" />
                        </div>
                        <p>未生成视频</p>
                        {state.error && <p className="text-xs text-red-300 max-w-md text-center">{state.error}</p>}
                    </div>
                )}
            </div>

            {code && (
                <div className="bento-card md:col-span-4 bg-slate-50/80 border border-slate-200">
                    <div className="flex items-center gap-2 text-slate-700 mb-2">
                        <FileCode2 size={18} />
                        <h3 className="font-bold">生成的 Manim 代码</h3>
                    </div>
                    <pre className="text-[11px] leading-relaxed text-slate-700 bg-white/80 border border-slate-200 rounded-lg p-3 overflow-auto max-h-72 whitespace-pre-wrap">
                        {code}
                    </pre>
                </div>
            )}

            {state.finalText.trim() && (
                <div className="bento-card md:col-span-12 bg-emerald-50/40 border-l-4 border-emerald-300">
                    <div className="flex items-center gap-2 text-emerald-700 mb-2">
                        <CheckCircle2 size={20} />
                        <h3 className="font-bold">小结</h3>
                    </div>
                    <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">{state.finalText}</p>
                </div>
            )}

            {onReset && (
                <div className="md:col-span-12 flex justify-end">
                    <button
                        onClick={onReset}
                        className="btn-secondary inline-flex items-center gap-2"
                    >
                        <RotateCcw size={14} /> 出新一题
                    </button>
                </div>
            )}
        </div>
    )
}

function extractManimCode(state: AgentRunState): string | null {
    for (let i = state.items.length - 1; i >= 0; i -= 1) {
        const item = state.items[i]
        if (item.kind !== 'tool') continue
        if (item.name !== 'generate_manim_code') continue
        const data = item.data
        if (data && typeof data['code'] === 'string') return data['code'] as string
    }
    return null
}
