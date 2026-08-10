import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'

export interface Learner {
    id: string
    name: string
    level: string
}

interface LearnerContextValue {
    learner: Learner | null
    learners: Learner[]
    loading: boolean
    /** 孩子会话锁定本人，切换无效；家长可切换查看 */
    select: (learner: Learner) => void
    /** 仅家长：手动建 learner（孩子经注册流程自动建） */
    create: (name: string, level: string) => Promise<Learner>
    refresh: () => Promise<void>
}

const LearnerContext = createContext<LearnerContextValue | null>(null)
const STORAGE_KEY = 'mathtutor:learnerId'

export function LearnerProvider({ children }: { children: ReactNode }) {
    const { status, user } = useAuth()
    const [learners, setLearners] = useState<Learner[]>([])
    const [learner, setLearner] = useState<Learner | null>(null)
    const [loading, setLoading] = useState(true)

    const isChild = user?.role === 'child'

    const refresh = useCallback(async () => {
        if (status !== 'authed' || !user) {
            setLearners([])
            setLearner(null)
            setLoading(status === 'loading')
            return
        }
        try {
            const res = await fetch('/api/v1/learners')
            const body = res.ok ? ((await res.json()) as { learners: Learner[] }) : { learners: [] }
            if (isChild) {
                // 孩子：learner 恒等于本人（服务端也会强制，这里只是 UI 一致性）
                const own =
                    body.learners.find((l) => l.id === user.learnerId) ??
                    ({ id: user.learnerId ?? '', name: user.username, level: 'elementary_upper' } as Learner)
                setLearners([own])
                setLearner(own)
            } else {
                setLearners(body.learners)
                const savedId = localStorage.getItem(STORAGE_KEY)
                const saved = body.learners.find((l) => l.id === savedId)
                setLearner((current) => {
                    const stillValid = current && body.learners.some((l) => l.id === current.id)
                    return (stillValid ? current : null) ?? saved ?? body.learners[0] ?? null
                })
            }
        } finally {
            setLoading(false)
        }
    }, [status, user, isChild])

    useEffect(() => {
        void refresh().catch(() => setLoading(false))
    }, [refresh])

    const select = useCallback(
        (next: Learner) => {
            if (isChild) return // 孩子锁定本人
            localStorage.setItem(STORAGE_KEY, next.id)
            setLearner(next)
        },
        [isChild]
    )

    const create = useCallback(
        async (name: string, level: string) => {
            const res = await fetch('/api/v1/learners', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name, level }),
            })
            if (!res.ok) throw new Error(`创建失败 (HTTP ${res.status})`)
            const body = (await res.json()) as { learner: Learner }
            await refresh()
            if (!isChild) {
                localStorage.setItem(STORAGE_KEY, body.learner.id)
                setLearner(body.learner)
            }
            return body.learner
        },
        [refresh, isChild]
    )

    return (
        <LearnerContext.Provider value={{ learner, learners, loading, select, create, refresh }}>
            {children}
        </LearnerContext.Provider>
    )
}

export function useLearner(): LearnerContextValue {
    const ctx = useContext(LearnerContext)
    if (!ctx) throw new Error('useLearner must be used within LearnerProvider')
    return ctx
}
