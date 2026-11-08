/**
 * 课堂页的 API 直连层。两件事：现在能开哪些课、某一节课的具体内容。
 *
 * 判卷**不在这里**：孩子答完题走已有的 /practice/submit（source=classroom），
 * 那条路有掌握度、证据等级、家长抽检；课堂自己再写一套判卷就是第二个会腐烂的实现。
 */

const API_BASE = '/api/v1'

export interface LessonOption {
    nodeId: string
    name: string
    stage: string
    /** 学科：界面按它分组（英语课不分组就永远排在数学课后面，翻不到） */
    subject: string
    questionCount: number
}

export interface LessonQuestion {
    questionId: string
    stem: string
    answerType: string
    options: string[] | null
    difficulty: number
    nodeIds: string[]
}

export interface ComposedLesson {
    nodeId: string
    nodeName: string
    scene: { scenes: unknown[]; [key: string]: unknown }
    narrations: string[]
    pauseBeatIndex: number
    question: LessonQuestion | null
    materialBeats: number
    pauseContext?: string
    /** 实际生效的模式：请求 generate 也可能拿回 compose */
    mode?: 'generate' | 'compose'
    /** 为什么退回 compose（没有就是 null） */
    degraded?: { reason: string } | null
    note?: string
}

export interface SubmitResult {
    correct: boolean
    counted?: boolean
    verification?: string
    correctAnswer?: string
    needsReview?: boolean
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${url}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const text = await res.text()
    const body = text ? (JSON.parse(text) as unknown) : null
    if (!res.ok) {
        /*
         * 服务端的 `error` 是给人看的一句话（关掉课堂时是「家长把『课堂』关掉了……」）。
         * 优先用它：403 是家长的决定，不该在孩子面前显示成「HTTP 403」。
         */
        const message =
            body && typeof body === 'object' && 'error' in body
                ? String((body as { error: unknown }).error)
                : res.statusText
        throw new Error(message)
    }
    return body as T
}

export function listLessons(): Promise<{ lessons: LessonOption[] }> {
    return json('/classroom/lessons')
}

/**
 * 拉一节课。
 *
 * `generate` 让模型把讲解写出来，`compose` 用离线材料拼。服务端保证 generate
 * 失败一定退回 compose（响应里的 `mode` 说实际用的是哪种），所以前端不需要自己重试。
 */
export function getLesson(nodeId: string, mode: 'generate' | 'compose' = 'compose'): Promise<ComposedLesson> {
    return json(`/classroom/lesson?nodeId=${encodeURIComponent(nodeId)}&mode=${mode}`)
}

/** 课堂作答：写进证据链，来源单列为 classroom（和课后练习分得开） */
export function submitClassroomAnswer(input: {
    learnerId: string
    questionId: string
    answer: string
    durationS?: number
}): Promise<SubmitResult> {
    return json('/practice/submit', {
        method: 'POST',
        body: JSON.stringify({ ...input, source: 'classroom' }),
    })
}
