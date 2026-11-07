import { useCallback, useEffect, useState } from 'react'

import { Badge, Button, Card } from '../ui'
import {
    deleteMemory,
    fetchMemories,
    fetchProfile,
    postProfile,
    type LearnerProfile,
    type TutorMemory,
} from './api'

/**
 * 家长中心里的「导师记忆与画像」面板。
 *
 * 这一块存在的意义就是**让"记住"这件事可审**：
 * 每条记忆都写着它从哪来（作答推出 / 自己填的），家长能一条条删，
 * 删掉之后导师立刻不再用它——做不到这一点的记忆，等于家长在自欺。
 */

const KIND_LABEL: Record<string, string> = {
    struggle: '卡住的',
    strength: '拿手的',
    preference: '偏好',
    goal: '目标',
}

const fieldCls =
    'w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px] focus:outline-none focus:border-beam focus:ring-2 focus:ring-beam-wash'

function splitTags(text: string): string[] {
    return text
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
}

export function MemoryPanel({ learnerId }: { learnerId: string }) {
    const [memories, setMemories] = useState<TutorMemory[] | null>(null)
    const [profile, setProfile] = useState<LearnerProfile | null>(null)
    const [interests, setInterests] = useState('')
    const [goals, setGoals] = useState('')
    const [prefersVisual, setPrefersVisual] = useState<boolean | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            const [memoryResult, nextProfile] = await Promise.all([fetchMemories(learnerId), fetchProfile(learnerId)])
            setMemories(memoryResult.memories)
            setProfile(nextProfile)
            setInterests(nextProfile.interests.join('、'))
            setGoals(nextProfile.goals.join('、'))
            setPrefersVisual(nextProfile.prefersVisual)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        void load()
    }, [load])

    const remove = async (id: string) => {
        try {
            await deleteMemory(learnerId, id)
            setMemories((prev) => (prev ?? []).filter((m) => m.id !== id))
            setNotice('已删除，导师之后不会再提起这件事')
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }

    const saveProfile = async () => {
        setError(null)
        try {
            const next = await postProfile({
                learnerId,
                interests: splitTags(interests),
                goals: splitTags(goals),
                prefersVisual,
            })
            setProfile(next)
            setNotice('画像已保存')
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }

    return (
        <Card className="p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">导师记忆与画像</h3>
                <Badge tone="slate">{memories?.length ?? 0} 条记忆</Badge>
            </div>

            {error && <div className="text-sm text-[color:var(--color-wrong)]">{error}</div>}
            {notice && <div className="text-sm text-[color:var(--color-correct)]">{notice}</div>}

            <div className="space-y-2">
                <div className="text-sm text-ink-soft">导师记住的事（每条都写着怎么来的，可逐条删除）</div>
                {!memories || memories.length === 0 ? (
                    <div className="text-sm text-ink-faint">还没有记忆。孩子做几道题之后会有。</div>
                ) : (
                    <ul className="space-y-1">
                        {memories.map((memory) => (
                            <li key={memory.id} className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                                <Badge tone={memory.kind === 'struggle' ? 'amber' : memory.kind === 'strength' ? 'emerald' : 'sky'}>
                                    {KIND_LABEL[memory.kind] ?? memory.kind}
                                </Badge>
                                <span>{memory.text}</span>
                                {memory.hitCount > 1 && <span className="text-xs text-ink-faint">×{memory.hitCount}</span>}
                                <span className="text-xs text-ink-faint">
                                    {memory.source === 'derived' ? '由作答记录推出' : '手填'}
                                </span>
                                <button
                                    type="button"
                                    className="text-xs text-[color:var(--color-wrong)] hover:underline"
                                    onClick={() => void remove(memory.id)}
                                >
                                    删除
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="space-y-2 border-t border-rule pt-3">
                <div className="text-sm text-ink-soft">学习者画像（导师据此出题和讲解；全部手填，不猜）</div>
                <label className="block">
                    <span className="eyebrow block mb-1">兴趣（用顿号或逗号分隔）</span>
                    <input
                        className={fieldCls}
                        value={interests}
                        onChange={(e) => setInterests(e.target.value)}
                        placeholder="足球、恐龙、做饭"
                        aria-label="兴趣"
                    />
                </label>
                <label className="block">
                    <span className="eyebrow block mb-1">近期目标</span>
                    <input
                        className={fieldCls}
                        value={goals}
                        onChange={(e) => setGoals(e.target.value)}
                        placeholder="学会通分"
                        aria-label="近期目标"
                    />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                    <span className="eyebrow">更吃哪种讲法</span>
                    {[
                        { label: '先画图', value: true },
                        { label: '先列式', value: false },
                        { label: '还没看出来', value: null },
                    ].map((option) => (
                        <Button
                            key={String(option.value)}
                            size="sm"
                            variant={prefersVisual === option.value ? 'primary' : 'secondary'}
                            onClick={() => setPrefersVisual(option.value)}
                        >
                            {option.label}
                        </Button>
                    ))}
                    <Button size="sm" onClick={() => void saveProfile()}>
                        保存画像
                    </Button>
                </div>
                {profile && profile.interests.length === 0 && <div className="text-xs text-ink-faint">还没填过画像。</div>}
            </div>
        </Card>
    )
}
