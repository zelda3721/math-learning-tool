/**
 * 英语页 API 直连层：类型照 apps/server/src/routes/english.ts 的响应写死。
 *
 * 两条线（词汇 / 阅读）都在这里收口，是为了让"失败怎么说"只有一处：
 * 服务端把该对孩子说的话放在 `error` 里（403 是家长关掉模块的那句），
 * 这里原样抛出，界面层只负责决定"整页拦住"还是"这一块重试"。
 */

export interface VocabCard {
    id: string
    zh: string
    en: string
    cefr: string
    example: string
}

/** 卡片的两个方向：看英文说中文、看中文写英文 */
export type VocabDirection = 'en2zh' | 'zh2en'

export interface VocabTaskPayload {
    card: VocabCard
    direction: VocabDirection
}

/** 复习卡比新词多一个 cardId（服务端复习卡的 id，本页不直接用它推进） */
export interface VocabReviewPayload extends VocabTaskPayload {
    cardId: string
}

export interface VocabStats {
    total: number
    learning: number
    mastered: number
    dueToday: number
}

export interface VocabToday {
    newWords: VocabTaskPayload[]
    reviews: VocabReviewPayload[]
    stats: VocabStats
    /** 服务端给的那一句话：今天的词练完没有、先复习还是先学新词 */
    note: string
}

export interface VocabProgress {
    stage: number
    mastered: boolean
    nextReviewAt: string | null
}

export interface VocabAnswerResult {
    correct: boolean
    /** 参考答案（词表里印着的那个），答错时给孩子看 */
    reference: string
    /** 英语没有可执行验算，判定依据恒为 reference（词表） */
    verification: 'reference'
    progress: VocabProgress
    /** 只有答错时服务端才给例句 */
    example?: string
}

export interface ReadingSummary {
    id: string
    title: string
    level: string
    words: number
    questionCount: number
    /** 这篇已经答对的题数 */
    answered: number
    done: boolean
}

/** 加载时被丢掉的题：证据对不上原文的题不进题库，这里只是如实交代 */
export interface ReadingDropped {
    passageId: string
    questionId: string
    why: string
}

export interface ReadingList {
    passages: ReadingSummary[]
    dropped: ReadingDropped[]
}

export interface PassageQuestion {
    id: string
    prompt: string
}

/** 短文视图：**不带答案与证据**（证据只在该题答对之后才下发） */
export interface Passage {
    id: string
    title: string
    level: string
    text: string
    questions: PassageQuestion[]
}

/** 答对才给 reference + evidence；答错只给一句 hint——亮原文等于把答案念出来 */
export type ReadingAnswerResult =
    | { correct: true; reference: string; evidence: string }
    | { correct: false; hint: string }

/** 接口连不上 / 服务端没说人话时的兜底：一句孩子读得懂的话，不是状态码 */
export const GENERIC_FAILURE = '暂时打不开，稍后再试'

/**
 * 带上 HTTP 状态的错误：界面靠它区分"家长关掉了"（403）和"服务出了点事"。
 * 文案始终优先用服务端给的那句话——「HTTP 403」对孩子等于什么都没说。
 */
export class EnglishApiError extends Error {
    readonly status: number

    constructor(message: string, status: number) {
        super(message)
        this.name = 'EnglishApiError'
        this.status = status
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
        res = await fetch(path, init)
    } catch {
        // 断网 / 服务没起：fetch 直接抛，此时连状态码都没有
        throw new EnglishApiError(GENERIC_FAILURE, 0)
    }
    if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new EnglishApiError(body?.error ?? GENERIC_FAILURE, res.status)
    }
    return (await res.json()) as T
}

function postJson<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

export function fetchVocabToday(learnerId: string): Promise<VocabToday> {
    return request<VocabToday>(
        `/api/v1/en/vocabulary/today?learnerId=${encodeURIComponent(learnerId)}`,
    )
}

export function postVocabAnswer(payload: {
    learnerId: string
    wordId: string
    answer: string
    direction: VocabDirection
    /** 「再记一次」的重写：服务端据此不推进 SM-2（进度不动） */
    retry?: boolean
}): Promise<VocabAnswerResult> {
    return postJson<VocabAnswerResult>('/api/v1/en/vocabulary/answer', payload)
}

export function fetchReadingList(learnerId: string): Promise<ReadingList> {
    return request<ReadingList>(
        `/api/v1/en/reading/list?learnerId=${encodeURIComponent(learnerId)}`,
    )
}

/** 读原文要带 learnerId：服务端按它过英语模块开关和每日时长（孩子会话会自动补上，家长会话必须带） */
export function fetchPassage(id: string, learnerId: string): Promise<Passage> {
    return request<Passage>(
        `/api/v1/en/reading/passage?id=${encodeURIComponent(id)}&learnerId=${encodeURIComponent(learnerId)}`,
    )
}

export function postReadingAnswer(payload: {
    learnerId: string
    passageId: string
    questionId: string
    answer: string
}): Promise<ReadingAnswerResult> {
    return postJson<ReadingAnswerResult>('/api/v1/en/reading/answer', payload)
}
