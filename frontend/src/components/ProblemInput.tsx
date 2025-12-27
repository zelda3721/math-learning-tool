import { useState } from 'react'
import { Send, Pencil, Lightbulb } from 'lucide-react'
import type { Grade } from '../services/api'

interface ProblemInputProps {
    onSubmit: (problem: string) => void
    isLoading: boolean
    selectedGrade?: string
    grades?: Grade[]
}

export function ProblemInput({ onSubmit, isLoading, selectedGrade, grades }: ProblemInputProps) {
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

    // Get current grade's example problem
    const currentGrade = grades?.find(g => g.level === selectedGrade)
    const exampleProblem = currentGrade?.example_problem || "小明有5个苹果，吃了2个，还剩几个？"

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
                    placeholder={`例如：${exampleProblem}`}
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

            {/* Grade-specific Example Chips */}
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
                <div className="text-xs text-slate-400 flex items-center gap-1 mr-2">
                    <Lightbulb size={14} />
                    <span>试试这些：</span>
                </div>
                {grades?.slice(0, 4).map((grade) => (
                    <button
                        key={grade.level}
                        type="button"
                        onClick={() => setProblem(grade.example_problem)}
                        className={`text-xs px-3 py-1.5 rounded-full transition-colors ${selectedGrade === grade.level
                                ? 'bg-sky-100 text-sky-700 ring-1 ring-sky-300'
                                : 'bg-slate-100 text-slate-500 hover:bg-sky-50 hover:text-sky-600'
                            }`}
                    >
                        {grade.display_name}：{grade.example_problem.slice(0, 15)}...
                    </button>
                ))}
            </div>
        </form>
    )
}
