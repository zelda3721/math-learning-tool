/**
 * ProblemInput — 工作台的题目输入区：大输入框 + 拍题识别 + 提交按钮 + 各年级例题快捷条。
 */
import { useState, useRef, useEffect } from 'react'
import type { Grade } from '../services/api'

import { Button, MathText } from '../ui'
import { PhotoProblemButton } from './PhotoProblemButton'

interface ProblemInputProps {
    /** figureImage：拍照识别裁出的题干配图（data URL）；手动输入时为 undefined */
    onSubmit: (problem: string, figureImage?: string, problemImage?: string) => void
    isLoading: boolean
    selectedGrade?: string
    onGradeChange?: (grade: string) => void
    grades?: Grade[]
}

export function ProblemInput({ onSubmit, isLoading, selectedGrade, onGradeChange, grades }: ProblemInputProps) {
    const [problem, setProblem] = useState('')
    // 拍照识别出的题干配图，随题目一起交给讲解
    const [figureImage, setFigureImage] = useState<string | undefined>()
    // 整道题的照片（题干 + 图）：图片本身就是题，解题时连题干一起给模型看
    const [problemImage, setProblemImage] = useState<string | undefined>()
    const [photoError, setPhotoError] = useState<string | null>(null)
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
            onSubmit(problem, figureImage, problemImage)
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

            {/* 输入框里的 $...$ 只能是源码；含 LaTeX 时在下面给一份渲染好的预览，
                识别出来的题到底对不对，一眼能看出来（公式渲染失败时 MathText 原样显示） */}
            {/[$\\]/.test(problem) && (
                <div className="rounded-[10px] border border-rule bg-paper px-3 py-2 text-sm leading-relaxed">
                    <span className="eyebrow block mb-1">预览</span>
                    <MathText>{problem}</MathText>
                </div>
            )}

            {figureImage && (
                <div className="flex items-start gap-3">
                    <img src={figureImage} alt="题干配图" className="max-h-36 max-w-full rounded border border-rule" />
                    <div className="space-y-1.5">
                        <p className="text-xs text-ink-faint">照片里裁出的配图，讲解会以它为底图。</p>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setFigureImage(undefined)}>
                            去掉这张图
                        </Button>
                    </div>
                </div>
            )}
            {photoError && <p className="text-sm text-wrong">{photoError}</p>}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-ink-faint">Enter 提交 · Shift + Enter 换行</span>
                <div className="flex items-center gap-2">
                    <PhotoProblemButton
                        level={selectedGrade}
                        size="md"
                        disabled={isLoading}
                        onExtracted={({ problem: extracted, figureImage: figure, problemImage: whole }) => {
                            // 只回填不提交：识别错一个数字，讲解就整个跑偏，先让人过目
                            setProblem(extracted)
                            setFigureImage(figure)
                            setProblemImage(whole)
                            setPhotoError(null)
                        }}
                        onError={setPhotoError}
                    />
                    <Button type="submit" disabled={!problem.trim() || isLoading}>
                        {isLoading ? '生成中……' : '开始讲解'}
                    </Button>
                </div>
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
