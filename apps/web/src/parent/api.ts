/** 家长聚合页 API 直连层：类型镜像 server 的 parent 路由响应，fetch 风格沿用 practice/api.ts。 */

import type { MasteryChange } from '../practice/api'

export interface TrendDay {
    date: string
    attempts: number
    correct: number
    hints: number
}

export interface MistakePattern {
    nodeId: string
    nodeName: string
    count: number
    /** 占全部错因的比例 0~1，用作条形宽度 */
    share: number
    avgConfidence: number
    latest: string
}

export interface PendingVerdict {
    attemptId: string
    questionId: string
    questionStem: string
    correctAnswer: string
    studentAnswer: string
    at: string
}

export interface MasterySummary {
    lit: number
    glow: number
    dim: number
    tracked: number
}

export interface RecentMistake {
    id: string
    questionStem?: string
    rootNodeId: string
    rootNodeName: string
    confidence: number
    eligible: boolean
    correctedByParent?: boolean
    createdAt: string
}

export interface ParentSummary {
    trend: TrendDay[]
    mistakePatterns: MistakePattern[]
    pendingVerdicts: PendingVerdict[]
    mastery: MasterySummary
    dueReviews: number
    recentMistakes: RecentMistake[]
}

/** 带 HTTP 状态码的错误：correct-mistake 需要区分 422（节点不存在）。 */
export class ApiError extends Error {
    readonly status: number

    constructor(message: string, status: number) {
        super(message)
        this.name = 'ApiError'
        this.status = status
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, init)
    if (!res.ok) {
        let message = `HTTP ${res.status}`
        try {
            const data = (await res.json()) as { error?: string }
            if (data.error) message = data.error
        } catch {
            /* 保留 HTTP 状态码信息 */
        }
        throw new ApiError(message, res.status)
    }
    return (await res.json()) as T
}

function post<T>(path: string, body: unknown): Promise<T> {
    return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

export function fetchParentSummary(learnerId: string): Promise<ParentSummary> {
    return request(`/api/v1/parent/summary?learnerId=${encodeURIComponent(learnerId)}`)
}

export function postVerdict(payload: {
    attemptId: string
    verdict: 'correct' | 'incorrect'
    note?: string
}): Promise<{ ok: boolean; mastery: MasteryChange[] }> {
    return post('/api/v1/parent/verdict', payload)
}

export function postCorrectMistake(payload: {
    mistakeId: string
    rootNodeId?: string
}): Promise<{ ok: boolean }> {
    return post('/api/v1/parent/correct-mistake', payload)
}
