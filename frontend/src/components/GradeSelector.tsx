import type { Grade } from '../services/api'
import { Sparkles } from 'lucide-react'

interface GradeSelectorProps {
    grades: Grade[]
    selectedGrade: string
    onSelect: (grade: string) => void
    isLoading?: boolean
}

export function GradeSelector({
    grades,
    selectedGrade,
    onSelect,
    isLoading,
}: GradeSelectorProps) {
    if (isLoading) {
        return (
            <div className="flex justify-center gap-3">
                {[1, 2, 3].map((i) => (
                    <div
                        key={i}
                        className="h-10 w-24 bg-slate-200/50 rounded-full animate-pulse"
                    />
                ))}
            </div>
        )
    }

    return (
        <div className="flex flex-col items-center gap-3">
            <div className="inline-flex bg-slate-100/80 p-1.5 rounded-full shadow-inner gap-1 overflow-x-auto max-w-full">
                {grades.map((grade) => {
                    const isSelected = selectedGrade === grade.level
                    return (
                        <button
                            key={grade.level}
                            onClick={() => onSelect(grade.level)}
                            className={`
                                relative px-5 py-2 rounded-full text-sm font-medium transition-all duration-300 whitespace-nowrap
                                ${isSelected
                                    ? 'text-sky-700 shadow-sm bg-white'
                                    : 'text-slate-500 hover:text-slate-700 hover:bg-white/50'
                                }
                            `}
                        >
                            {isSelected && (
                                <span className="absolute inset-0 bg-white rounded-full shadow-sm z-0" loading="lazy" />
                            )}
                            <span className="relative z-10 flex items-center gap-2">
                                {grade.display_name}
                                {isSelected && <Sparkles size={14} className="text-amber-400" />}
                            </span>
                        </button>
                    )
                })}
            </div>

            {/* Thinking Style Hint */}
            <div className="text-xs text-slate-400 animate-fade-in opacity-80 h-5">
                {grades.find(g => g.level === selectedGrade)?.thinking_style || ''}
            </div>
        </div>
    )
}
