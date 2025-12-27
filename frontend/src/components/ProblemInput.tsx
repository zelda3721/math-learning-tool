import { useState } from 'react'
import { Send, Sparkles, Pencil } from 'lucide-react'

interface ProblemInputProps {
    onSubmit: (problem: string) => void
    isLoading: boolean
}

export function ProblemInput({ onSubmit, isLoading }: ProblemInputProps) {
    const [problem, setProblem] = useState('')

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (problem.trim() && !isLoading) {
            onSubmit(problem)
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit(e)
        }
    }

    return (
        <form onSubmit={handleSubmit} className="w-full relative">
            <div className="absolute -top-3 left-4 bg-gradient-to-r from-sky-400 to-indigo-500 text-white text-xs font-bold px-3 py-1 rounded-full shadow-md z-10 flex items-center gap-1">
                <Pencil size={12} />
                <span>输入题目</span>
            </div>

            <div className="relative group">
                <textarea
                    value={problem}
                    onChange={(e) => setProblem(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="例如：小明有5个苹果，吃了2个，还剩几个？..."
                    className="input-hero min-h-[140px] resize-none pt-6 pl-6 pr-24 text-lg md:text-xl leading-relaxed"
                />

                <div className="absolute bottom-4 right-4 flex items-center gap-2">
                    <span className={`text-xs transition-opacity duration-300 ${problem.length > 0 ? 'opacity-100' : 'opacity-0'} text-slate-400`}>
                        Shift + Enter 换行
                    </span>
                    <button
                        type="submit"
                        disabled={!problem.trim() || isLoading}
                        className={`
                            h-12 w-12 rounded-2xl flex items-center justify-center transition-all duration-300
                            ${!problem.trim() || isLoading
                                ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                                : 'bg-gradient-to-tr from-sky-500 to-indigo-600 text-white shadow-lg shadow-sky-200 hover:scale-110 hover:shadow-sky-300 active:scale-95'
                            }
                        `}
                    >
                        {isLoading ? (
                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                            <Send size={22} className={problem.trim() ? 'ml-0.5' : ''} />
                        )}
                    </button>
                </div>
            </div>

            {/* Helper Chips */}
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
                <button type="button" onClick={() => setProblem("25 + 18 = ?")} className="text-xs px-3 py-1.5 bg-slate-100 text-slate-500 rounded-full hover:bg-sky-50 hover:text-sky-600 transition-colors">
                    🎲 25 + 18 = ?
                </button>
                <button type="button" onClick={() => setProblem("鸡兔同笼，头35，脚94，各多少？")} className="text-xs px-3 py-1.5 bg-slate-100 text-slate-500 rounded-full hover:bg-sky-50 hover:text-sky-600 transition-colors">
                    🐰 鸡兔同笼
                </button>
                <button type="button" onClick={() => setProblem("一个长方形长5cm宽3cm，求面积")} className="text-xs px-3 py-1.5 bg-slate-100 text-slate-500 rounded-full hover:bg-sky-50 hover:text-sky-600 transition-colors">
                    📐 几何面积
                </button>
            </div>
        </form>
    )
}
