/** 练习页 API 直连层：照 LearnerContext 的 fetch 风格，类型对齐 server routes/practice.ts 的响应。 */

import type { validateSpec } from '@mathtutor/explainer-web'
import type { FigureSpec } from '@mathtutor/explainer-web'

/** 'asked' 是前端专有槽位：孩子自由提问转成的临时题目，server 的今日题组不会返回它 */
export type Slot = 'review' | 'queue' | 'weak' | 'new' | 'challenge' | 'asked'
export type MasteryBand = 'dim' | 'glow' | 'lit'

export interface PracticeQuestion {
    id: string
    stem: string
    /** 几何题的配图规格（点线角 + 约束）；坐标由前端解算并逐条回代验证后才画 */
    /** 原题原图的文件名，走 /api/v1/figures/:name 取 */
    figureImage?: string
    figure?: FigureSpec
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

/**
 * 讲解元数据（镜像 server explain/routes.ts explanationView）。
 * mode 决定看哪个字段：web → specUrl（SceneSpec 交播放器）、
 * web_html → htmlUrl（模型直写的页面，必须放进 sandbox iframe）、video → videoUrl。
 */
export interface Explanation {
    id: string
    questionId?: string
    focusNodeIds: string[]
    mode: string
    specUrl?: string
    htmlUrl?: string
    videoUrl?: string
    subtitleUrl?: string
    quality: string
    /** 已给过的人工偏好：clear / confusing */
    feedbackLabel?: string
}

/** SceneSpec 类型从 explainer-web 契约推导：validateSpec 的非空 spec 即真源类型 */
export type SceneSpec = NonNullable<ReturnType<typeof validateSpec>['spec']>

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
    /** 自由题目文本（讲解 tab 直接输入，不经题库） */
    problem?: string
    grade?: string
}

export type ExplainResponse =
    | {
          status: 'ready'
          explanation: Explanation
          /** 同题的其它形态讲解（both 模式下的另一份），用于并排对比 */
          alternatives?: Explanation[]
          fallback: ExplainFallback
      }
    | { status: 'generating'; jobId: string; mode?: string; fallback: ExplainFallback }
    | { status: 'offline'; fallback: ExplainFallback; message: string }

export interface ExplainJobStatus {
    status: 'running' | 'done' | 'failed'
    explanation?: Explanation
    alternatives?: Explanation[]
    error?: string
}

/**
 * 「哪个讲得更清楚」。门禁只能判有没有画错，判不了讲没讲明白——
 * 这条标签是后者唯一的来源，也是日后训练最值钱的那部分。
 */
export function sendExplanationFeedback(
    explanationId: string,
    label: 'clear' | 'confusing',
    extra: { learnerId?: string; comparedWith?: string } = {},
): Promise<{ ok: boolean }> {
    return post(`/api/v1/explain/${encodeURIComponent(explanationId)}/feedback`, {
        label,
        ...extra,
    })
}

export type VariantResponse =
    | { kind: 'bank' | 'generated'; question: PracticeQuestion }
    | { kind: 'none'; message: string }

/** 失败响应 → Error：优先用 server 的 error 文案，取不到退回 HTTP 状态码。 */
async function httpError(res: Response): Promise<Error> {
    let message = `HTTP ${res.status}`
    try {
        const data = (await res.json()) as { error?: string }
        if (data.error) message = data.error
    } catch {
        /* 保留 HTTP 状态码信息 */
    }
    return new Error(message)
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

/** 不传 mode 走 server 默认（EXPLAIN_WEB_MODE）；显式指定才覆盖 */
export function requestExplain(
    payload: ExplainRequest,
    mode?: 'web' | 'web_html' | 'video',
): Promise<ExplainResponse> {
    return post('/api/v1/explain', mode ? { ...payload, mode } : payload)
}

/** 拉取 web 讲解的 SceneSpec JSON（调用方仍需过 validateSpec 再挂播放器） */
export async function fetchSpec(specUrl: string): Promise<SceneSpec> {
    const res = await fetch(specUrl)
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
    return (await res.json()) as SceneSpec
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

/* ── 「问一道题」：自由输入 → 引擎解题验算 → 临时题目，之后全程复用练习端点 ── */

/** 缓存命中直接给题（isNew=false 表示这题之前问过）；否则给 jobId 轮询 */
export type AskResponse =
    | { status: 'ready'; question: PracticeQuestion; isNew: boolean }
    | { status: 'pending'; jobId: string }

export interface AskJobStatus {
    status: 'running' | 'done' | 'failed'
    question?: PracticeQuestion
    error?: string
}

/** POST /ask：202 给 jobId，200 给题（内容哈希命中缓存）。按字段判形，容忍 server 状态码微调。 */
export async function askQuestion(payload: {
    learnerId: string
    problem: string
    grade?: string
}): Promise<AskResponse> {
    const res = await fetch('/api/v1/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    })
    if (!res.ok) throw await httpError(res)
    const data = (await res.json()) as { jobId?: string; question?: PracticeQuestion; isNew?: boolean }
    if (data.question) return { status: 'ready', question: data.question, isNew: data.isNew ?? true }
    if (data.jobId) return { status: 'pending', jobId: data.jobId }
    throw new Error('没读懂服务端的回复')
}

export async function fetchAskJob(jobId: string): Promise<AskJobStatus> {
    const res = await fetch(`/api/v1/ask/jobs/${encodeURIComponent(jobId)}`)
    if (!res.ok) throw await httpError(res)
    return (await res.json()) as AskJobStatus
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
