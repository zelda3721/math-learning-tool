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

/** 一份讲解的画面由谁设计：确定性构造器的章，或 llm_director（模型写的计划） */
export interface ExplanationSource {
    mode: string
    source: string
    quality: string
    count: number
    /** 人工偏好票数：门禁只能判有没有画错，判不了讲没讲明白 */
    clear_votes: number
    confusing_votes: number
}

/** 卡住的题：从作答记录直接汇总（错题本只收归因过的，覆盖不了这类挣扎） */
export interface Struggle {
    questionId: string
    stem: string
    answer?: string
    wrongCount: number
    /** 最后自己解出来了没有 */
    solved: boolean
    /** 孩子填过的错误答案（最多 3 个） */
    childAnswers: string[]
    nodeNames: string[]
    problemTypeName?: string
    lastAt: string
}

export interface WeakNode {
    nodeId: string
    nodeName: string
    p: number
    evidenceN: number
    band: 'dim' | 'glow'
}

export interface ParentSummary {
    trend: TrendDay[]
    mistakePatterns: MistakePattern[]
    struggles?: Struggle[]
    weakNodes?: WeakNode[]
    pendingVerdicts: PendingVerdict[]
    mastery: MasterySummary
    dueReviews: number
    recentMistakes: RecentMistake[]
    /** 全库口径的产线质量指标（不分孩子）；旧后端没有这个字段 */
    explanationSources?: ExplanationSource[]
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


// ---- 内容安全与时长（阶段 4） ----

export interface SafetyEvent {
    at: string
    /** 「孩子输入」/「模型输出」 */
    where: string
    /** 「拦下」/「转移话题」 */
    action: string
    reason: string
}

export interface SafetyReport {
    events: SafetyEvent[]
    byReason: Record<string, number>
    total: number
}

export interface ChatLimits {
    learnerId: string
    allowed: boolean
    usedMinutes: number
    limitMinutes: number
    remainingMinutes: number
    /** 上限是家长设的还是按学段默认 */
    source: 'parent' | 'default'
    defaults: Record<string, number>
}

export function fetchSafety(learnerId: string): Promise<SafetyReport> {
    return request(`/api/v1/parent/safety?learnerId=${encodeURIComponent(learnerId)}`)
}

export function fetchLimits(learnerId: string): Promise<ChatLimits> {
    return request(`/api/v1/parent/limits?learnerId=${encodeURIComponent(learnerId)}`)
}

/** `dailyChatMinutes: null` = 恢复按学段默认 */
export function postLimits(payload: { learnerId: string; dailyChatMinutes: number | null }): Promise<ChatLimits> {
    return post('/api/v1/parent/limits', payload)
}


// ---- 导师记忆与学习者画像（阶段 4） ----

export interface TutorMemory {
    id: string
    kind: string
    text: string
    hitCount: number
    source: string
    updatedAt: string
    deletedAt: string | null
}

export interface LearnerProfile {
    interests: string[]
    goals: string[]
    prefersVisual: boolean | null
}

export function fetchMemories(learnerId: string, includeDeleted = false): Promise<{ memories: TutorMemory[] }> {
    return request(
        `/api/v1/parent/memories?learnerId=${encodeURIComponent(learnerId)}${includeDeleted ? '&includeDeleted=1' : ''}`,
    )
}

export function deleteMemory(learnerId: string, id: string): Promise<{ removed: boolean; remaining: number }> {
    return request(`/api/v1/parent/memories/${encodeURIComponent(id)}?learnerId=${encodeURIComponent(learnerId)}`, {
        method: 'DELETE',
    })
}

export function fetchProfile(learnerId: string): Promise<LearnerProfile> {
    return request(`/api/v1/parent/profile?learnerId=${encodeURIComponent(learnerId)}`)
}

export function postProfile(payload: {
    learnerId: string
    interests?: string[]
    goals?: string[]
    prefersVisual?: boolean | null
}): Promise<LearnerProfile> {
    return post('/api/v1/parent/profile', payload)
}


// ---- 对话转写（阶段 4：默认关，家长显式打开） ----

export interface TranscriptTurn {
    id: string
    ts: string
    /** user / assistant 是原话；blocked 表示这一轮被安全层拦下（没有原话） */
    role: 'user' | 'assistant' | 'blocked' | string
    content: string
    /** blocked 行的原因，形如 input:contact-request */
    safetyReason: string | null
}

export interface TranscriptReport {
    recording: boolean
    turns: TranscriptTurn[]
    note?: string
}

export function fetchTranscripts(learnerId: string, limit = 200): Promise<TranscriptReport> {
    return request(
        `/api/v1/parent/transcripts?learnerId=${encodeURIComponent(learnerId)}&limit=${limit}`,
    )
}

/** 开 / 关转写。关掉再打开**不回溯**：没记的那些话找不回来。 */
export function postTranscriptRecording(payload: { learnerId: string; enabled: boolean }): Promise<{
    recording: boolean
}> {
    return post('/api/v1/parent/transcripts/recording', payload)
}

export function deleteTranscripts(learnerId: string): Promise<{ removed: number }> {
    return request(`/api/v1/parent/transcripts?learnerId=${encodeURIComponent(learnerId)}`, {
        method: 'DELETE',
    })
}


// ---- AI 判断抽查（宪法第 5 条：ai_unverified 只作记录，不计掌握度） ----

export interface AiJudgmentItem {
    attemptId: string
    questionId: string
    stem: string
    studentAnswer: string
    correct: boolean
    at: string
    source: string
    hintLevelUsed: number
    /** 判卷依据：AI 当时给的理由；没有就明说"只有模型判断" */
    basis: string
    needsReview: boolean
    parentVerdict: 'correct' | 'incorrect' | null
    judgement: { action: string; note?: string; at: string } | null
}

export function fetchAiJudgments(learnerId: string): Promise<{ items: AiJudgmentItem[]; note?: string }> {
    return request(`/api/v1/parent/ai-judgments?learnerId=${encodeURIComponent(learnerId)}`)
}

export function postAiJudgment(payload: {
    attemptId: string
    action: 'reviewed' | 'overturn'
    note?: string
}): Promise<{ ok: boolean; needsReview: boolean }> {
    return post('/api/v1/parent/ai-judgment', payload)
}


// ---- 模块开关（家长可以整块关掉） ----

export interface ModuleCatalogEntry {
    id: string
    label: string
    hint: string
}

export interface ModuleState {
    modules: Record<string, boolean>
    catalog: ModuleCatalogEntry[]
}

export function fetchModules(learnerId: string): Promise<ModuleState> {
    return request(`/api/v1/parent/modules?learnerId=${encodeURIComponent(learnerId)}`)
}

export function postModules(payload: { learnerId: string; modules: Record<string, boolean> }): Promise<ModuleState> {
    return post('/api/v1/parent/modules', payload)
}


// ---- 独立性（孩子是在自己学，还是在依赖 AI） ----

export interface IndependenceReport {
    learnerId: string
    attempts: number
    firstSeenQuestions: number
    independentFirstCorrect: number
    /** 0~1；没有新题数据时是 null */
    independentRate: number | null
    /** 用了 0/1/2/3 级提示的作答数 */
    hintDistribution: [number, number, number, number]
    analysisViews: number
    askCount: number
    repeats: number
    selfExplain: number
    errorGuess: number
    verdict: string
}

export function fetchIndependence(learnerId: string): Promise<IndependenceReport> {
    return request(`/api/v1/parent/independence?learnerId=${encodeURIComponent(learnerId)}`)
}

export interface ReflectionItem {
    at: string
    questionId?: string
    questionStem?: string
    kind: 'self-explain' | 'error-guess'
    guess?: string
    text?: string
}

export function fetchReflections(learnerId: string): Promise<{ items: ReflectionItem[] }> {
    return request(`/api/v1/parent/reflections?learnerId=${encodeURIComponent(learnerId)}`)
}
