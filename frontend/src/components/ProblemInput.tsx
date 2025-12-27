import { useState } from 'react'

interface ProblemInputProps {
    onSubmit: (problem: string) => void
    isLoading?: boolean
}

export function ProblemInput({ onSubmit, isLoading }: ProblemInputProps) {
    const [problem, setProblem] = useState('')

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (problem.trim() && !isLoading) {
            onSubmit(problem.trim())
        }
    }

    const exampleProblems = [
        '小明有25个糖果，给了小红8个，又给了小刚5个，然后妈妈给了他10个。现在有多少个糖果？',
        '一个长方形的长是12厘米，宽是8厘米，求它的周长和面积。',
        '甲乙两车分别从A、B两地同时出发相向而行，甲车速度60公里/小时，乙车速度40公里/小时，AB两地相距200公里，问多久相遇？',
    ]

    return (
        <div className="space-y-4">
            <div className="glass p-6">
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label htmlFor="problem" className="block text-sm font-medium text-zinc-400 mb-2">
                            输入数学题目
                        </label>
                        <textarea
                            id="problem"
                            value={problem}
                            onChange={(e) => setProblem(e.target.value)}
                            placeholder="请输入您想解决的数学问题..."
                            rows={4}
                            className="input-glass resize-none"
                            disabled={isLoading}
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={!problem.trim() || isLoading}
                        className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isLoading ? (
                            <span className="flex items-center justify-center gap-2">
                                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                处理中...
                            </span>
                        ) : (
                            '开始分析 ✨'
                        )}
                    </button>
                </form>
            </div>

            {/* Example Problems */}
            <div>
                <p className="text-xs text-zinc-500 mb-2">示例题目：</p>
                <div className="flex flex-wrap gap-2">
                    {exampleProblems.map((example, i) => (
                        <button
                            key={i}
                            onClick={() => setProblem(example)}
                            disabled={isLoading}
                            className="text-xs px-3 py-1.5 glass text-zinc-400 hover:text-white 
                       hover:border-purple-500/30 transition-all truncate max-w-[200px]"
                        >
                            {example.slice(0, 30)}...
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}
