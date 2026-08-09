/** 练习页 API 直连层：照 LearnerContext 的 fetch 风格，类型对齐 server routes/practice.ts 的响应。 */

export type Slot = 'queue' | 'weak' | 'new' | 'challenge'
export type MasteryBand = 'dim' | 'glow' | 'lit'

export interface PracticeQuestion {
    id: string
    stem: string
    options?: string[]
    answerType: 'numeric' | 'expression' | 'steps'
    difficulty: number
    level: string
    nodeIds: string[]
    problemTypeId?: string
}

export interface TodayItem {
    slot: Slot
    queueItemId?: string
    question: PracticeQuestion
}

export interface MasteryChange {
    nodeId: string
    p: number
    band: MasteryBand
}

export interface SubmitResult {
    attemptId: string
    correct: boolean
    method: 'numeric' | 'expression' | 'string' | 'pending'
    needsReview: boolean
    hintAvailable: boolean
    mastery: MasteryChange[]
}

export interface HintResult {
    level: number
    hint: string
    source: string
}

async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        let message = `HTTP ${res.status}`
        try {
            const data = (await res.json()) as { error?: string }
            if (data.error) message = data.error
        } catch {
            /* 保留 HTTP 状态码信息 */
        }
        throw new Error(message)
    }
    return (await res.json()) as T
}

export function fetchToday(learnerId: string, count?: number): Promise<{ items: TodayItem[] }> {
    return post('/api/v1/practice/today', count ? { learnerId, count } : { learnerId })
}

export function submitAnswer(payload: {
    learnerId: string
    questionId: string
    answer: string
    hintLevelUsed: number
    durationS: number
    queueItemId?: string
}): Promise<SubmitResult> {
    return post('/api/v1/practice/submit', payload)
}

export function fetchHint(payload: {
    learnerId: string
    questionId: string
    level: number
    lastWrongAnswer?: string
}): Promise<HintResult> {
    return post('/api/v1/practice/hint', payload)
}

/** 小结页节点名映射（best-effort）：取 atlas graph 的 id → name，失败返回空表。 */
export async function fetchNodeNames(learnerId: string): Promise<Record<string, string>> {
    try {
        const res = await fetch(`/api/v1/atlas?learnerId=${encodeURIComponent(learnerId)}`)
        if (!res.ok) return {}
        const data = (await res.json()) as { graph?: { nodes?: { id: string; name: string }[] } }
        const map: Record<string, string> = {}
        for (const node of data.graph?.nodes ?? []) map[node.id] = node.name
        return map
    } catch {
        return {}
    }
}
