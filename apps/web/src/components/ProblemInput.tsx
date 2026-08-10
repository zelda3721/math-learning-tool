/**
 * ProblemInput — 工作台的题目输入区：大输入框 + 提交按钮 + 各年级例题快捷条。
 */
import { useState, useRef, useEffect } from 'react'
import type { Grade } from '../services/api'

import { Button } from '../ui'

interface ProblemInputProps {
    onSubmit: (problem: string) => void
    isLoading: boolean
    selectedGrade?: string
    onGradeChange?: (grade: string) => void
    grades?: Grade[]
}

export function ProblemInput({ onSubmit, isLoading, selectedGrade, onGradeChange, grades }: ProblemInputProps) {
    const [problem, setProblem] = useState('')
    const exampleRefs = useRef<{ [key: string]: HTMLButtonElement | null }>({})

    // 年级切换时把对应例题滚到可见位置
    useEffect(() => {
        if (selectedGrade && exampleRefs.current[selectedGrade]) {
            exampleRefs.current[selectedGrade]?.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
                inline: 'center',
            })
        }
    }, [selectedGrade])

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

    // 点击例题：同时同步年级与题目
    const handleExampleClick = (grade: Grade) => {
        setProblem(grade.example_problem)
        onGradeChange?.(grade.level)
    }

    const currentGrade = grades?.find((g) => g.level === selectedGrade)
    const exampleProblem = currentGrade?.example_problem || '小明有5个苹果，吃了2个，还剩几个？'

    return (
        <form onSubmit={handleSubmit} className="space-y-3">
            <label className="block space-y-1.5">
                <span className="eyebrow block">题目</span>
                <textarea
                    value={problem}
                    onChange={(e) => setProblem(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={`例如：${exampleProblem}`}
                    className="input-hero min-h-[120px] resize-y leading-relaxed"
                />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-ink-faint">Enter 提交 · Shift + Enter 换行</span>
                <Button type="submit" disabled={!problem.trim() || isLoading}>
                    {isLoading ? '生成中……' : '开始讲解'}
                </Button>
            </div>

            {grades && grades.length > 0 && (
                <div className="pt-1 border-t border-rule">
                    <p className="eyebrow pt-3 pb-2">试试这些例题</p>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                        {grades.map((grade) => (
                            <button
                                key={grade.level}
                                ref={(el) => {
                                    exampleRefs.current[grade.level] = el
                                }}
                                type="button"
                                onClick={() => handleExampleClick(grade)}
                                className={`text-xs px-3 py-1.5 rounded-[10px] border whitespace-nowrap flex-shrink-0 transition-colors ${
                                    selectedGrade === grade.level
                                        ? 'border-beam bg-beam-wash text-beam font-semibold'
                                        : 'border-rule bg-plate text-ink-soft hover:border-beam hover:text-beam'
                                }`}
                            >
                                {grade.display_name}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </form>
    )
}
