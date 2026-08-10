/**
 * 两种讲法的切换与投票。
 *
 * `EXPLAIN_WEB_MODE=both` 时同一道题会产出两份讲解——模型现写的页面，
 * 和 SceneSpec 交给固定播放器渲染的动画。不把两份摆在一起，人就没法判断
 * 「模型直写到底强在哪」，而这恰恰是门禁判不了的部分：它只管有没有画错，
 * 管不了讲没讲明白。
 *
 * 投票只有两个选项。选项一多就没人认真填，两个还能顺手点一下。
 */
import { useState } from 'react'
import { sendExplanationFeedback, type Explanation } from './api'

const MODE_LABEL: Record<string, string> = {
    web: '动画讲解',
    web_html: '模型现写',
    video: '视频',
}

interface Props {
    current: Explanation
    alternatives: Explanation[]
    learnerId?: string
    onSelect: (explanation: Explanation) => void
}

export function ExplanationCompare({ current, alternatives, learnerId, onSelect }: Props) {
    const [voted, setVoted] = useState<string | undefined>(current.feedbackLabel)
    const [sending, setSending] = useState(false)

    if (alternatives.length === 0) return null
    const all = [current, ...alternatives]

    const vote = (label: 'clear' | 'confusing') => {
        if (sending) return
        setSending(true)
        setVoted(label)
        void sendExplanationFeedback(current.id, label, {
            learnerId,
            comparedWith: alternatives[0]?.id,
        })
            .catch(() => setVoted(undefined))
            .finally(() => setSending(false))
    }

    return (
        <div className="rounded-[10px] border border-rule bg-paper px-4 py-3 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow">换个讲法</span>
                {all.map((item) => {
                    const active = item.id === current.id
                    return (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => onSelect(item)}
                            aria-current={active}
                            className={`text-sm px-3 py-1 rounded-full border transition-colors ${
                                active
                                    ? 'bg-beam border-beam text-white font-semibold'
                                    : 'bg-plate border-rule text-ink-soft hover:border-beam hover:text-beam'
                            }`}
                        >
                            {MODE_LABEL[item.mode] ?? item.mode}
                        </button>
                    )
                })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink-faint">这一版讲得清楚吗？</span>
                <button
                    type="button"
                    onClick={() => vote('clear')}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                        voted === 'clear'
                            ? 'border-correct text-[color:var(--color-correct)] bg-correct-wash font-semibold'
                            : 'border-rule text-ink-soft hover:border-correct'
                    }`}
                >
                    讲清楚了
                </button>
                <button
                    type="button"
                    onClick={() => vote('confusing')}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                        voted === 'confusing'
                            ? 'border-wrong text-[color:var(--color-wrong)] bg-wrong-wash font-semibold'
                            : 'border-rule text-ink-soft hover:border-wrong'
                    }`}
                >
                    没看懂
                </button>
                {voted && <span className="text-xs text-ink-faint">记下了</span>}
            </div>
        </div>
    )
}
