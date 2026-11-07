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

export function getLesson(nodeId: string): Promise<ComposedLesson> {
    return json(`/classroom/lesson?nodeId=${encodeURIComponent(nodeId)}`)
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
