/**
 * FeedbackBar — collects 👍/👎/neutral marks for a session and optionally
 * promotes the manim_code artifact into the few-shot examples store.
 */
import { useState } from 'react'
import { ThumbsUp, ThumbsDown, Sparkles, Send, CheckCircle2 } from 'lucide-react'

import { api } from '../services/api'

interface FeedbackBarProps {
    sessionId: string
    hasManimCode: boolean
    grade: string
}

type Label = 'good' | 'bad' | 'neutral'

export function FeedbackBar({ sessionId, hasManimCode }: FeedbackBarProps) {
    const [label, setLabel] = useState<Label | null>(null)
    const [notes, setNotes] = useState('')
    const [tags, setTags] = useState('')
    const [promote, setPromote] = useState(true)
    const [submitting, setSubmitting] = useState(false)
    const [submitted, setSubmitted] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const canSubmit = label !== null && !submitting

    async function onSubmit() {
        if (label === null) return
        setSubmitting(true)
        setError(null)
        try {
            await api.submitFeedback(sessionId, { label, notes })
            if (promote && hasManimCode && (label === 'good' || label === 'bad')) {
                await api.promoteExample(sessionId, {
                    label,
                    notes,
                    tags: tags
                        .split(/[,，\s]+/)
                        .map((t) => t.trim())
                        .filter(Boolean),
                })
            }
            setSubmitted(true)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setSubmitting(false)
        }
    }

    if (submitted) {
        return (
            <div className="bento-card md:col-span-12 bg-emerald-50/50 border-l-4 border-emerald-400">
                <div className="flex items-center gap-2 text-emerald-700">
                    <CheckCircle2 size={20} />
                    <span className="font-bold">谢谢反馈！</span>
                </div>
                <p className="text-sm text-emerald-700/70 mt-1">
                    {promote && hasManimCode && (label === 'good' || label === 'bad')
                        ? '本次代码已加入示例库，下次类似题目会被检索为参考。'
                        : '反馈已记录到本会话。'}
                </p>
            </div>
        )
    }

    return (
        <div className="bento-card md:col-span-12 bg-white/70 border-l-4 border-violet-300">
            <div className="flex items-center gap-2 text-violet-700 mb-3">
                <Sparkles size={20} />
                <h3 className="font-bold">这次结果怎么样？</h3>
            </div>

            <div className="flex gap-3 mb-4">
                <LabelButton
                    label="good"
                    active={label === 'good'}
                    onClick={() => setLabel('good')}
                    icon={<ThumbsUp size={16} />}
                    text="不错"
                    activeCls="bg-emerald-500 text-white border-emerald-500"
                    idleCls="border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                />
                <LabelButton
                    label="bad"
                    active={label === 'bad'}
                    onClick={() => setLabel('bad')}
                    icon={<ThumbsDown size={16} />}
                    text="不行"
                    activeCls="bg-red-500 text-white border-red-500"
                    idleCls="border-red-200 text-red-700 hover:bg-red-50"
                />
                <LabelButton
                    label="neutral"
                    active={label === 'neutral'}
                    onClick={() => setLabel('neutral')}
                    icon={null}
                    text="一般"
                    activeCls="bg-slate-500 text-white border-slate-500"
                    idleCls="border-slate-200 text-slate-700 hover:bg-slate-50"
                />
            </div>

            <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="可选备注：哪里好 / 哪里需要改 / 错的地方在哪..."
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm placeholder:text-slate-300 focus:border-violet-300 focus:ring-2 focus:ring-violet-100 outline-none resize-y min-h-[72px]"
            />

            {(label === 'good' || label === 'bad') && hasManimCode && (
                <div className="mt-3 space-y-2">
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                            type="checkbox"
                            checked={promote}
                            onChange={(e) => setPromote(e.target.checked)}
                            className="w-4 h-4 accent-violet-500"
                        />
                        加入示例库（{label === 'good' ? '良好样本' : '失败样本'}），用于下次 few-shot 参考
                    </label>
                    {promote && (
                        <input
                            value={tags}
                            onChange={(e) => setTags(e.target.value)}
                            placeholder="标签（用逗号或空格分隔，如：鸡兔同笼,假设法）"
                            className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs placeholder:text-slate-300 focus:border-violet-300 focus:ring-2 focus:ring-violet-100 outline-none"
                        />
                    )}
                </div>
            )}

            {error && (
                <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                    {error}
                </div>
            )}

            <div className="mt-4 flex justify-end">
                <button
                    onClick={onSubmit}
                    disabled={!canSubmit}
                    className="inline-flex items-center gap-2 btn-primary disabled:opacity-40 disabled:cursor-not-allowed disabled:translate-y-0"
                >
                    <Send size={16} />
                    {submitting ? '提交中...' : '提交反馈'}
                </button>
            </div>
        </div>
    )
}

function LabelButton({
    active,
    onClick,
    icon,
    text,
    activeCls,
    idleCls,
}: {
    label: Label
    active: boolean
    onClick: () => void
    icon: React.ReactNode
    text: string
    activeCls: string
    idleCls: string
}) {
    return (
        <button
            onClick={onClick}
            className={`flex-1 px-3 py-2 rounded-xl border transition-all text-sm font-medium flex items-center justify-center gap-2 ${active ? activeCls : idleCls
                }`}
        >
            {icon}
            {text}
        </button>
    )
}
