import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useLearner } from '../learner/LearnerContext'
import { Button, Field } from '../ui'

export const LEVEL_OPTIONS = [
    ['elementary_lower', '小学低年级'],
    ['elementary_upper', '小学高年级'],
    ['middle', '初中'],
    ['high', '高中'],
    ['advanced', '大学'],
] as const

export function levelLabel(level: string): string {
    return LEVEL_OPTIONS.find(([key]) => key === level)?.[1] ?? level
}

/** 无 learner 时的选人 / 建档卡（孩子会话恒有本人档案，此卡只对家长出现）。 */
export function LearnerGate() {
    const { user } = useAuth()
    const { learners, loading, select, create } = useLearner()
    const [name, setName] = useState('')
    const [level, setLevel] = useState('elementary_upper')
    const [creating, setCreating] = useState(false)
    const [error, setError] = useState<string | null>(null)

    if (loading) {
        return <div className="text-center text-ink-faint py-16">正在加载学习档案……</div>
    }

    // 孩子理论上不会到这（learner 恒为本人）；万一档案缺失给明确提示而非建档表单
    if (user?.role === 'child') {
        return (
            <div className="plate p-8 max-w-lg mx-auto text-center text-ink-soft">
                你的学习档案暂时加载不出来，刷新一下试试；还不行就找家长看看。
            </div>
        )
    }

    const handleCreate = async (e: FormEvent) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed || creating) return
        setCreating(true)
        setError(null)
        try {
            await create(trimmed, level)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setCreating(false)
        }
    }

    return (
        <div className="plate p-8 max-w-lg mx-auto space-y-6">
            <div className="text-center space-y-1">
                <h2 className="text-2xl font-bold text-ink tracking-tight">今天谁来练习?</h2>
                <p className="text-ink-soft text-sm">选一个名字，或者建一个新档案。</p>
            </div>

            {learners.length > 0 && (
                <div className="space-y-2">
                    <div className="flex flex-wrap gap-2 justify-center">
                        {learners.map((l) => (
                            <Button key={l.id} variant="secondary" onClick={() => select(l)}>
                                <span className="font-semibold text-ink">{l.name}</span>
                                <span className="ml-2 text-xs font-normal text-ink-faint">
                                    {levelLabel(l.level)}
                                </span>
                            </Button>
                        ))}
                    </div>
                    <div className="flex items-center gap-3 pt-2">
                        <div className="flex-1 h-px bg-rule" />
                        <span className="eyebrow">或建新档案</span>
                        <div className="flex-1 h-px bg-rule" />
                    </div>
                </div>
            )}

            <form onSubmit={handleCreate} className="space-y-4">
                <Field label="名字">
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="你的名字"
                        className="input-hero"
                    />
                </Field>
                <Field label="学段">
                    <select
                        value={level}
                        onChange={(e) => setLevel(e.target.value)}
                        className="input-hero"
                    >
                        {LEVEL_OPTIONS.map(([key, label]) => (
                            <option key={key} value={key}>
                                {label}
                            </option>
                        ))}
                    </select>
                </Field>
                <Button type="submit" size="lg" disabled={!name.trim() || creating} className="w-full">
                    {creating ? '创建中……' : '开始学习'}
                </Button>
                {error && <p className="text-sm text-wrong text-center">{error}</p>}
            </form>
        </div>
    )
}

/** 已有 learner 时的顶部切换条（孩子只显示本人，不可切换）。 */
export function LearnerSwitcher({ disabled }: { disabled?: boolean }) {
    const { user } = useAuth()
    const { learner, learners, select } = useLearner()
    if (!learner) return null
    const others = user?.role === 'child' ? [] : learners.filter((l) => l.id !== learner.id)
    return (
        <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
            <span className="inline-flex items-baseline gap-1.5 rounded-[10px] bg-beam px-3.5 py-1.5 text-sm font-semibold text-white">
                {learner.name}
                <span className="text-xs font-normal text-white/75">{levelLabel(learner.level)}</span>
            </span>
            {others.map((l) => (
                <Button
                    key={l.id}
                    size="sm"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => select(l)}
                >
                    {l.name}
                </Button>
            ))}
        </div>
    )
}
