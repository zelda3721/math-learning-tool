/**
 * FeedbackBar — 给一次会话打 👍/👎/一般，并可把 manim_code 产物提升为 few-shot 示例。
 */
import { useState } from 'react'
import { ThumbsUp, ThumbsDown } from 'lucide-react'

import { api } from '../services/api'
import { Button } from '../ui'

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
            <div className="plate border-l-[3px] border-l-beam p-5">
                <p className="font-semibold text-ink">谢谢反馈</p>
                <p className="text-sm text-ink-soft mt-1">
                    {promote && hasManimCode && (label === 'good' || label === 'bad')
                        ? '本次代码已加入示例库，下次类似题目会被检索为参考。'
                        : '反馈已记录到本会话。'}
                </p>
            </div>
        )
    }

    return (
        <div className="plate p-5 space-y-4">
            <p className="eyebrow">这次结果怎么样</p>

            <div className="flex flex-wrap gap-2">
                <LabelButton
                    active={label === 'good'}
                    onClick={() => setLabel('good')}
                    icon={<ThumbsUp size={15} />}
                    text="不错"
                    activeCls="bg-[color:var(--color-correct)] text-white border-correct"
                    idleCls="border-rule text-ink-soft hover:border-correct hover:text-correct"
                />
                <LabelButton
                    active={label === 'bad'}
                    onClick={() => setLabel('bad')}
                    icon={<ThumbsDown size={15} />}
                    text="不行"
                    activeCls="bg-wrong text-white border-wrong"
                    idleCls="border-rule text-ink-soft hover:border-wrong hover:text-wrong"
                />
                <LabelButton
                    active={label === 'neutral'}
                    onClick={() => setLabel('neutral')}
                    icon={null}
                    text="一般"
                    activeCls="bg-ink-soft text-white border-ink-soft"
                    idleCls="border-rule text-ink-soft hover:border-beam hover:text-beam"
                />
            </div>

            <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="可选备注：哪里好 / 哪里需要改 / 错的地方在哪……"
                className="w-full px-3 py-2 rounded-[10px] border border-rule bg-plate text-sm text-ink
                           placeholder:text-ink-faint focus:border-beam focus:outline-none resize-y min-h-[72px]"
            />

            {(label === 'good' || label === 'bad') && hasManimCode && (
                <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm text-ink-soft">
                        <input
                            type="checkbox"
                            checked={promote}
                            onChange={(e) => setPromote(e.target.checked)}
                            className="w-4 h-4 accent-beam"
                        />
                        加入示例库（{label === 'good' ? '良好样本' : '失败样本'}），用于下次 few-shot 参考
                    </label>
                    {promote && (
                        <input
                            value={tags}
                            onChange={(e) => setTags(e.target.value)}
                            placeholder="标签（用逗号或空格分隔，如：鸡兔同笼,假设法）"
                            className="w-full px-3 py-1.5 rounded-[10px] border border-rule bg-plate text-xs text-ink
                                       placeholder:text-ink-faint focus:border-beam focus:outline-none"
                        />
                    )}
                </div>
            )}

            {error && (
                <p className="px-3 py-2 rounded-[10px] bg-wrong-wash border border-wrong/20 text-xs text-wrong">
                    {error}
                </p>
            )}

            <div className="flex justify-end">
                <Button size="sm" onClick={onSubmit} disabled={!canSubmit}>
                    {submitting ? '提交中……' : '提交反馈'}
                </Button>
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
    active: boolean
    onClick: () => void
    icon: React.ReactNode
    text: string
    activeCls: string
    idleCls: string
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex-1 min-w-[96px] px-3 py-2 rounded-[10px] border text-sm font-medium
                        flex items-center justify-center gap-2 transition-colors ${active ? activeCls : idleCls}`}
        >
            {icon}
            {text}
        </button>
    )
}
