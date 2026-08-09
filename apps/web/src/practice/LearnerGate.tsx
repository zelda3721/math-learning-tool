import { useState, type FormEvent } from 'react'
import { useLearner } from '../learner/LearnerContext'

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

/** 无 learner 时的选人 / 建档卡。 */
export function LearnerGate() {
    const { learners, loading, select, create } = useLearner()
    const [name, setName] = useState('')
    const [level, setLevel] = useState('elementary_upper')
    const [creating, setCreating] = useState(false)
    const [error, setError] = useState<string | null>(null)

    if (loading) {
        return <div className="text-center text-slate-400 py-16">正在加载学习档案……</div>
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
        <div className="soft-glass p-8 max-w-lg mx-auto space-y-6">
            <div className="text-center space-y-1">
                <h2 className="text-2xl font-bold text-slate-700">今天谁来练习?</h2>
                <p className="text-slate-500 text-sm">选一个名字，或者建一个新档案。</p>
            </div>

            {learners.length > 0 && (
                <div className="space-y-2">
                    <div className="flex flex-wrap gap-2 justify-center">
                        {learners.map((l) => (
                            <button
                                key={l.id}
                                type="button"
                                onClick={() => select(l)}
                                className="px-5 py-2.5 rounded-2xl bg-white border-2 border-slate-100 hover:border-sky-300 hover:bg-sky-50 transition-colors text-slate-700 font-semibold shadow-sm"
                            >
                                {l.name}
                                <span className="ml-2 text-xs font-normal text-slate-400">
                                    {levelLabel(l.level)}
                                </span>
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-3 pt-2">
                        <div className="flex-1 h-px bg-slate-200" />
                        <span className="text-xs text-slate-400">或建新档案</span>
                        <div className="flex-1 h-px bg-slate-200" />
                    </div>
                </div>
            )}

            <form onSubmit={handleCreate} className="space-y-3">
                <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="你的名字"
                    className="w-full px-4 py-3 text-lg bg-white border-2 border-slate-100 rounded-2xl placeholder:text-slate-300 text-slate-700 focus:outline-none focus:border-sky-400 focus:ring-4 focus:ring-sky-100 transition-all"
                />
                <select
                    value={level}
                    onChange={(e) => setLevel(e.target.value)}
                    className="w-full px-4 py-3 text-lg bg-white border-2 border-slate-100 rounded-2xl text-slate-700 focus:outline-none focus:border-sky-400 focus:ring-4 focus:ring-sky-100 transition-all"
                >
                    {LEVEL_OPTIONS.map(([key, label]) => (
                        <option key={key} value={key}>
                            {label}
                        </option>
                    ))}
                </select>
                <button
                    type="submit"
                    disabled={!name.trim() || creating}
                    className="w-full py-3 rounded-2xl bg-sky-500 text-white text-lg font-bold shadow-lg shadow-sky-200 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {creating ? '创建中……' : '开始学习'}
                </button>
                {error && <p className="text-sm text-red-500 text-center">{error}</p>}
            </form>
        </div>
    )
}

/** 已有 learner 时的顶部切换条。 */
export function LearnerSwitcher({ disabled }: { disabled?: boolean }) {
    const { learner, learners, select } = useLearner()
    if (!learner) return null
    const others = learners.filter((l) => l.id !== learner.id)
    return (
        <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
            <span className="px-4 py-1.5 rounded-full bg-sky-500 text-white text-sm font-semibold shadow">
                {learner.name}
                <span className="ml-1.5 text-sky-100 font-normal text-xs">{levelLabel(learner.level)}</span>
            </span>
            {others.map((l) => (
                <button
                    key={l.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => select(l)}
                    className="px-4 py-1.5 rounded-full bg-white/80 border border-slate-200 text-sm text-slate-500 hover:text-slate-800 hover:border-sky-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {l.name}
                </button>
            ))}
        </div>
    )
}
