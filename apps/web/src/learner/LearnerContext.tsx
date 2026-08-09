import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export interface Learner {
    id: string
    name: string
    level: string
}

interface LearnerContextValue {
    learner: Learner | null
    learners: Learner[]
    loading: boolean
    select: (learner: Learner) => void
    create: (name: string, level: string) => Promise<Learner>
    refresh: () => Promise<void>
}

const LearnerContext = createContext<LearnerContextValue | null>(null)
const STORAGE_KEY = 'mathtutor:learnerId'

export function LearnerProvider({ children }: { children: ReactNode }) {
    const [learners, setLearners] = useState<Learner[]>([])
    const [learner, setLearner] = useState<Learner | null>(null)
    const [loading, setLoading] = useState(true)

    const refresh = useCallback(async () => {
        try {
            const res = await fetch('/api/v1/learners')
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const body = (await res.json()) as { learners: Learner[] }
            setLearners(body.learners)
            const savedId = localStorage.getItem(STORAGE_KEY)
            const saved = body.learners.find((l) => l.id === savedId)
            setLearner((current) => current ?? saved ?? null)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void refresh().catch(() => setLoading(false))
    }, [refresh])

    const select = useCallback((next: Learner) => {
        localStorage.setItem(STORAGE_KEY, next.id)
        setLearner(next)
    }, [])

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
            select(body.learner)
            return body.learner
        },
        [refresh, select]
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
