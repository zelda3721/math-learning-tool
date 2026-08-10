/** 练习页 API 直连层：照 LearnerContext 的 fetch 风格，类型对齐 server routes/practice.ts 的响应。 */

export type Slot = 'review' | 'queue' | 'weak' | 'new' | 'challenge'
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
    /** 复习槽位携带：submit 带上它推进 SM-2 */
    reviewCardId?: string
    question: PracticeQuestion
}

export interface MasteryChange {
    nodeId: string
    p: number
    band: MasteryBand
}

/** SM-2 复习卡推进结果（submit 带 reviewCardId 时返回） */
export interface ReviewProgress {
    stage: number
    mastered: boolean
    nextReviewAt: string | null
}

export interface SubmitResult {
    attemptId: string
    correct: boolean
    method: 'numeric' | 'expression' | 'string' | 'pending'
    needsReview: boolean
    hintAvailable: boolean
    mastery: MasteryChange[]
    review?: ReviewProgress
}

export interface HintResult {
    level: number
    hint: string
    source: string
}

/** 归因结果：错因 = 图谱坐标 + 置信度 + 依据链（镜像 server diagnosis.ts DiagnosisResult） */
export interface DiagnosisResult {
    mistakeId: string
    /** false = 根因未核验，只给定位；探针题已排队等实证 */
    eligible: boolean
    surface: 'concept' | 'procedure' | 'calculation' | 'reading'
    rootNodeId: string
    rootNodeName: string
    misconceptionId?: string
    misconceptionDesc?: string
    chain: string[]
    chainNames: string[]
    confidence: number
    explanation: string
    probesQueued: string[]
}

/** 错题列表项（GET /diagnosis/mistakes） */
export interface MistakeSummary {
    id: string
    attemptId: string
    learnerId: string
    questionId: string
    questionStem?: string
    surface: string
    rootNodeId: string
    rootNodeName: string
    misconceptionId?: string
    chain: string[]
    chainNames: string[]
    confidence: number
    eligible: boolean
    createdAt: string
}

/** 讲解视频元数据（镜像 server explain/routes.ts explanationView） */
export interface Explanation {
    id: string
    questionId?: string
    focusNodeIds: string[]
    mode: string
    videoUrl: string
    subtitleUrl?: string
    quality: string
}

/** 图文兜底：任何分支都即时可读，不等视频 */
export interface ExplainFallback {
    rootNode?: { name: string; whatIsIt?: string; why?: string }
    chainNames?: string[]
    misconceptionDesc?: string
    analysis?: string
}

export interface ExplainRequest {
    learnerId?: string
    questionId?: string
    focusNodeId?: string
    misconceptionId?: string
    mistakeId?: string
}

export type ExplainResponse =
    | { status: 'ready'; explanation: Explanation; fallback: ExplainFallback }
    | { status: 'generating'; jobId: string; fallback: ExplainFallback }
    | { status: 'offline'; fallback: ExplainFallback; message: string }

export interface ExplainJobStatus {
    status: 'running' | 'done' | 'failed'
    explanation?: Explanation
    error?: string
}

export type VariantResponse =
    | { kind: 'bank' | 'generated'; question: PracticeQuestion }
    | { kind: 'none'; message: string }

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
    reviewCardId?: string
    source?: 'daily' | 'probe' | 'variant' | 'review' | 'explore'
}): Promise<SubmitResult> {
    return post('/api/v1/practice/submit', payload)
}

/** 学生「下一步」一句话建议（GET /practice/next-step） */
export interface NextStep {
    nextStep: string
    kind: 'review' | 'weak' | 'new'
    nodeId?: string
}

/** best-effort：失败返回 null，idle 卡片直接不显示。 */
export async function fetchNextStep(learnerId: string): Promise<NextStep | null> {
    try {
        const res = await fetch(`/api/v1/practice/next-step?learnerId=${encodeURIComponent(learnerId)}`)
        if (!res.ok) return null
        return (await res.json()) as NextStep
    } catch {
        return null
    }
}

/** 已点亮星星数（best-effort）：atlas mastery 中 band === 'lit' 的个数，失败返回 null 不显示。 */
export async function fetchLitCount(learnerId: string): Promise<number | null> {
    try {
        const res = await fetch(`/api/v1/atlas?learnerId=${encodeURIComponent(learnerId)}`)
        if (!res.ok) return null
        const data = (await res.json()) as { mastery?: Record<string, { band?: string }> }
        return Object.values(data.mastery ?? {}).filter((m) => m.band === 'lit').length
    } catch {
        return null
    }
}

/** 拍照作答判卷结果（POST /practice/submit-photo） */
export interface PhotoSubmitResult {
    attemptId: string
    correct: boolean
    extractedAnswer: string
    confident: boolean
    needsReview: boolean
    hintAvailable: boolean
    mastery: MasteryChange[]
    review?: ReviewProgress
}

/** 501 = server 未配置 vision LLM：调用方隐藏拍照入口，不当异常抛。 */
export type PhotoSubmitResponse =
    | { status: 'ok'; result: PhotoSubmitResult }
    | { status: 'unconfigured' }

export async function submitPhoto(payload: {
    learnerId: string
    questionId: string
    /** dataURL（data:image/...;base64,...） */
    image: string
    hintLevelUsed?: number
    durationS?: number
    queueItemId?: string
    reviewCardId?: string
    source?: 'daily' | 'probe' | 'variant' | 'review' | 'explore'
}): Promise<PhotoSubmitResponse> {
    const res = await fetch('/api/v1/practice/submit-photo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    })
    if (res.status === 501) return { status: 'unconfigured' }
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
    return { status: 'ok', result: (await res.json()) as PhotoSubmitResult }
}

export function diagnoseAttempt(attemptId: string): Promise<DiagnosisResult> {
    return post(`/api/v1/diagnosis/${encodeURIComponent(attemptId)}`, {})
}

/** 错题列表（best-effort）：小结页展示用，失败返回空表不打断流程。 */
export async function fetchMistakes(learnerId: string): Promise<MistakeSummary[]> {
    try {
        const res = await fetch(`/api/v1/diagnosis/mistakes?learnerId=${encodeURIComponent(learnerId)}`)
        if (!res.ok) return []
        const data = (await res.json()) as { mistakes?: MistakeSummary[] }
        return data.mistakes ?? []
    } catch {
        return []
    }
}

export function requestExplain(payload: ExplainRequest): Promise<ExplainResponse> {
    return post('/api/v1/explain', payload)
}

export async function fetchExplainJob(jobId: string): Promise<ExplainJobStatus> {
    const res = await fetch(`/api/v1/explain/jobs/${encodeURIComponent(jobId)}`)
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
    return (await res.json()) as ExplainJobStatus
}

export function fetchVariant(payload: { learnerId: string; questionId: string }): Promise<VariantResponse> {
    return post('/api/v1/practice/variant', payload)
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
