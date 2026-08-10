/**
 * GradeSelector — 工作台里的年级选择器。
 * 紧凑下拉（不是横向大胶囊条），选中年级的思维风格作为 hint 显示。
 */
import type { Grade } from '../services/api'
import { Field } from '../ui'

interface GradeSelectorProps {
    grades: Grade[]
    selectedGrade: string
    onSelect: (grade: string) => void
    isLoading?: boolean
}

export function GradeSelector({ grades, selectedGrade, onSelect, isLoading }: GradeSelectorProps) {
    const current = grades.find((g) => g.level === selectedGrade)

    return (
        <Field label="年级" hint={isLoading ? '正在读取年级……' : current?.thinking_style}>
            <select
                value={selectedGrade}
                onChange={(e) => onSelect(e.target.value)}
                disabled={isLoading || grades.length === 0}
                className="w-full sm:w-60 px-3 py-2 rounded-[10px] border border-rule bg-plate text-[15px] text-ink
                           focus:border-beam focus:outline-none disabled:text-ink-faint disabled:cursor-not-allowed"
            >
                {grades.length === 0 && <option value={selectedGrade}>{isLoading ? '加载中……' : '暂无年级'}</option>}
                {grades.map((grade) => (
                    <option key={grade.level} value={grade.level}>
                        {grade.display_name}
                    </option>
                ))}
            </select>
        </Field>
    )
}
