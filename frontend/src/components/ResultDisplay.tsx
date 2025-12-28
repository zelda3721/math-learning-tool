import type { ProcessProblemResponse } from '../services/api'
import { Play, BookOpen, CheckCircle, BrainCircuit } from 'lucide-react'

interface ResultDisplayProps {
    result: ProcessProblemResponse
}

export function ResultDisplay({ result }: ResultDisplayProps) {
    if (result.error) {
        return (
            <div className="soft-glass-panel p-8 border-l-4 border-red-400 bg-red-50/50 flex flex-col items-center text-center">
                <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mb-4">
                    <span className="text-2xl">😕</span>
                </div>
                <h3 className="text-xl font-bold text-slate-800 mb-2">哎呀，遇到个小问题</h3>
                <p className="text-slate-600 max-w-md">{result.error}</p>
            </div>
        )
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 animate-fade-in-up">

            {/* 1. Analysis Card (Left/Top) */}
            {result.analysis && (
                <div className="bento-card md:col-span-4 bg-gradient-to-br from-indigo-50 to-white border-l-4 border-indigo-400">
                    <div className="flex items-center gap-2 text-indigo-600 mb-2">
                        <BrainCircuit size={20} />
                        <h3 className="font-bold">题目分析</h3>
                    </div>

                    <div className="space-y-4">
                        <div className="flex justify-between items-center pb-2 border-b border-indigo-100">
                            <span className="text-sm text-slate-500">类型</span>
                            <span className="font-medium text-slate-700">{result.analysis.problem_type || '综合题'}</span>
                        </div>
                        <div className="flex justify-between items-center pb-2 border-b border-indigo-100">
                            <span className="text-sm text-slate-500">难度</span>
                            <span className={`text-xs px-2 py-1 rounded-full font-bold ${result.analysis.difficulty === 'hard' ? 'bg-red-100 text-red-600' :
                                result.analysis.difficulty === 'medium' ? 'bg-amber-100 text-amber-600' :
                                    'bg-green-100 text-green-600'
                                }`}>
                                {result.analysis.difficulty?.toUpperCase() || 'NORMAL'}
                            </span>
                        </div>

                        <div>
                            <span className="text-sm text-slate-500 block mb-2">知识点</span>
                            <div className="flex flex-wrap gap-2">
                                {result.analysis.concepts?.map((c, i) => (
                                    <span key={i} className="text-xs px-2 py-1 bg-indigo-100 text-indigo-700 rounded-md">
                                        {c}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* 2. Video/Visualization Card (Right/Top - Big focus) */}
            <div className={`bento-card ${result.analysis ? 'md:col-span-8' : 'md:col-span-12'} min-h-[300px] bg-slate-900 border-none relative overflow-hidden group`}>
                {result.video_url ? (
                    <>
                        <video src={result.video_url} controls className="w-full h-full object-contain rounded-xl z-10 relative" />
                        {/* Glow effect behind video */}
                        <div className="absolute inset-0 bg-blue-500/20 blur-3xl group-hover:bg-blue-500/30 transition-all duration-500"></div>
                        {/* Code viewer for successful videos */}
                        {result.visualization_code && (
                            <details className="absolute bottom-2 right-2 z-20">
                                <summary className="text-xs cursor-pointer bg-slate-800/80 px-2 py-1 rounded text-slate-400 hover:text-white">
                                    查看代码
                                </summary>
                                <pre className="mt-2 p-2 bg-black/90 rounded text-[10px] text-green-400 overflow-auto max-h-48 max-w-md">
                                    {result.visualization_code}
                                </pre>
                            </details>
                        )}
                    </>
                ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-slate-500 gap-4">
                        <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center">
                            <Play size={24} className="ml-1 text-slate-600" />
                        </div>
                        <p>生成视频失败或未生成</p>
                        {result.visualization_code && (
                            <details className="w-full max-w-md px-4 absolute bottom-4">
                                <summary className="text-xs text-center cursor-pointer opacity-50 hover:opacity-100">查看代码</summary>
                                <pre className="mt-2 p-2 bg-black/50 rounded text-[10px] text-green-400 overflow-auto max-h-32">
                                    {result.visualization_code}
                                </pre>
                            </details>
                        )}
                    </div>
                )}
            </div>

            {/* 3. Steps Card (Full Width) */}
            {result.solution && (
                <div className="bento-card md:col-span-12 bg-white/60">
                    <div className="flex items-center gap-2 text-sky-600 mb-4">
                        <BookOpen size={20} />
                        <h3 className="font-bold">解题步骤</h3>
                    </div>

                    <div className="relative pl-4 space-y-8 before:absolute before:left-[19px] before:top-4 before:bottom-4 before:w-0.5 before:bg-slate-200">
                        {result.solution.steps?.map((step, idx) => (
                            <div key={idx} className="relative flex gap-4 group">
                                <div className="z-10 w-10 h-10 rounded-full bg-white border-4 border-slate-100 text-sky-600 font-bold flex items-center justify-center shadow-sm group-hover:border-sky-100 group-hover:scale-110 transition-all">
                                    {step.step_number}
                                </div>
                                <div className="flex-1 pt-1">
                                    <p className="text-slate-700 text-lg leading-relaxed">{step.description}</p>
                                    <div className="mt-2 inline-block px-4 py-2 bg-slate-100 rounded-lg font-mono text-slate-600 text-sm border border-slate-200">
                                        {step.operation}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Final Answer */}
                    {result.solution.answer && (
                        <div className="mt-8 flex justify-end">
                            <div className="bg-gradient-to-r from-emerald-500 to-teal-500 text-white px-8 py-4 rounded-2xl shadow-lg transform rotate-1 hover:rotate-0 transition-all flex items-center gap-3">
                                <CheckCircle size={24} className="text-emerald-100" />
                                <div>
                                    <p className="text-emerald-100 text-xs font-bold uppercase tracking-wider">Final Answer</p>
                                    <p className="text-2xl font-bold">{result.solution.answer}</p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
