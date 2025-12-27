import type { ProcessProblemResponse } from '../services/api'

interface ResultDisplayProps {
    result: ProcessProblemResponse
}

export function ResultDisplay({ result }: ResultDisplayProps) {
    if (result.error) {
        return (
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6 border-red-500/30">
                <h3 className="text-lg font-semibold text-red-400 mb-2">处理失败</h3>
                <p className="text-zinc-400">{result.error}</p>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* Analysis Section */}
            {result.analysis && (
                <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6">
                    <h3 className="text-lg font-semibold gradient-text mb-4">📊 题目分析</h3>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <p className="text-xs text-zinc-500 mb-1">题型</p>
                            <p className="text-zinc-300">{result.analysis.problem_type || '-'}</p>
                        </div>
                        <div>
                            <p className="text-xs text-zinc-500 mb-1">难度</p>
                            <p className="text-zinc-300">{result.analysis.difficulty || '-'}</p>
                        </div>
                        <div className="col-span-2">
                            <p className="text-xs text-zinc-500 mb-1">涉及概念</p>
                            <div className="flex flex-wrap gap-2">
                                {result.analysis.concepts?.map((concept, i) => (
                                    <span key={i} className="px-2 py-1 bg-purple-500/20 rounded-lg text-sm text-purple-300">
                                        {concept}
                                    </span>
                                )) || '-'}
                            </div>
                        </div>
                        <div className="col-span-2">
                            <p className="text-xs text-zinc-500 mb-1">解题策略</p>
                            <p className="text-zinc-300">{result.analysis.strategy || '-'}</p>
                        </div>
                    </div>
                </div>
            )}

            {/* Solution Section */}
            {result.solution && (
                <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6">
                    <h3 className="text-lg font-semibold gradient-text mb-4">📝 解题步骤</h3>
                    <div className="space-y-4">
                        {result.solution.steps?.map((step) => (
                            <div key={step.step_number} className="flex gap-4">
                                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center flex-shrink-0">
                                    <span className="text-sm font-bold">{step.step_number}</span>
                                </div>
                                <div>
                                    <p className="text-zinc-300">{step.description}</p>
                                    <p className="text-sm text-zinc-500 mt-1">{step.operation}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                    {result.solution.answer && (
                        <div className="mt-6 p-4 bg-gradient-to-r from-purple-500/20 to-pink-500/20 rounded-xl border border-purple-500/30">
                            <p className="text-sm text-zinc-400 mb-1">最终答案</p>
                            <p className="text-xl font-bold text-white">{result.solution.answer}</p>
                        </div>
                    )}
                </div>
            )}

            {/* Video Section */}
            {result.video_url && (
                <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6">
                    <h3 className="text-lg font-semibold gradient-text mb-4">🎬 可视化视频</h3>
                    <video
                        src={result.video_url}
                        controls
                        className="w-full rounded-xl"
                    />
                </div>
            )}

            {/* Code Section */}
            {result.visualization_code && (
                <details className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6">
                    <summary className="cursor-pointer text-lg font-semibold text-zinc-400 hover:text-white transition-colors">
                        💻 查看Manim代码
                    </summary>
                    <pre className="mt-4 p-4 bg-black/30 rounded-xl overflow-x-auto text-sm text-zinc-300">
                        <code>{result.visualization_code}</code>
                    </pre>
                </details>
            )}
        </div>
    )
}
