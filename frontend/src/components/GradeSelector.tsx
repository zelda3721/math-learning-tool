import type { Grade } from '../services/api'

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
            <div className="flex gap-3">
                {[1, 2, 3, 4, 5].map((i) => (
                    <div
                        key={i}
                        className="h-12 w-28 bg-white/5 backdrop-blur-xl border border-white/10 rounded-xl animate-pulse"
                    />
                ))}
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-400">选择年级</h2>
            <div className="flex flex-wrap gap-3">
                {grades.map((grade) => (
                    <button
                        key={grade.level}
                        onClick={() => onSelect(grade.level)}
                        className={`px-4 py-3 rounded-xl font-medium transition-all duration-300 ${selectedGrade === grade.level
                            ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg shadow-purple-500/25'
                            : 'bg-white/5 backdrop-blur-xl border border-white/10 text-zinc-400 hover:text-white hover:border-purple-500/30'
                            }`}
                    >
                        {grade.display_name}
                    </button>
                ))}
            </div>
        </div>
    )
}

