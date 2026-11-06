/**
 * 教材编译页的 API 直连层。
 *
 * 三条路对应后端的三个动作：编译（后台任务）、出候选、确认排课。
 * 类型与 server 的响应一一对应，**不做**任何"顺手补个默认值"的加工——
 * 页面上要显示降级、未定位、被跳过的概念，这些信息一旦在客户端被抹平，
 * 家长就再也看不到"这份候选不可靠"。
 */

const API_BASE = '/api/v1/textbook'

export interface CompiledSummaryConcept {
    id: string
    title: string
    definition: string
    keyPointCount: number
    prerequisites: string[]
    sourceCount: number
    /** 有可定位原文出处的出处条数：0 表示这个概念只是线索 */
    verifiedSourceCount: number
    verified: boolean
    conflictCount: number
}

export interface CompileResult {
    title: string
    concepts: CompiledSummaryConcept[]
    links: { from: string; to: string; kind: string }[]
    unresolvedPrerequisites: { conceptId: string; title: string }[]
    coverage: {
        chapters: number
        chaptersWithConcepts: number
        concepts: number
        verifiedConcepts: number
    }
    degraded: boolean
    savedTo: string
    markdownDir: string
    note: string
}

export interface CompileJob {
    id: string
    status: 'running' | 'done' | 'failed'
    progress: { stage?: string; current?: number; total?: number; chapter?: string }
    result: CompileResult | null
    error: string | null
}

export interface ConceptSource {
    chapterTitle: string
    fromPage: number
    toPage: number
    quote: string
    verification: 'exact' | 'partial' | 'not_found'
}

export interface CompiledConcept extends CompiledSummaryConcept {
    sources: ConceptSource[]
    conflicts: { chapterTitle: string; fromPage: number; definition: string }[]
}

export interface CompiledBook {
    title: string
    concepts: CompiledConcept[]
    coverage: CompileResult['coverage']
    degraded: boolean
}

export interface AlignmentCandidate {
    nodeId: string
    nodeName: string
    score: number
    reasons: string[]
}

export interface AlignmentItem {
    conceptId: string
    conceptTitle: string
    candidates: AlignmentCandidate[]
    status: 'pending' | 'confirmed' | 'rejected'
}

export interface AlignResult {
    name: string
    items: AlignmentItem[]
    pendingCount: number
    skippedUnverified: number
    note: string
}

export interface PlannedLesson {
    order: number
    chapterTitle: string
    nodeId: string
    nodeName: string
    conceptId?: string
    movedBecauseOf: string[]
}

export interface ConfirmResult {
    name: string
    lessons: PlannedLesson[]
    cycleDetected: boolean
    savedTo: string
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const text = await res.text()
    const body = text ? (JSON.parse(text) as unknown) : null
    if (!res.ok) {
        const message =
            body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : res.statusText
        throw new Error(message)
    }
    return body as T
}

export function startCompile(input: { title: string; pdfBase64: string }): Promise<{ jobId?: string; chapters: number }> {
    return json(`${API_BASE}/compile`, { method: 'POST', body: JSON.stringify(input) })
}

export function getCompileJob(jobId: string): Promise<CompileJob> {
    return json(`${API_BASE}/compile/${encodeURIComponent(jobId)}`)
}

export function alignBook(name: string): Promise<AlignResult> {
    return json(`${API_BASE}/align`, { method: 'POST', body: JSON.stringify({ name }) })
}

export function confirmPlan(name: string, lessons: { conceptId: string; nodeId: string }[]): Promise<ConfirmResult> {
    return json(`${API_BASE}/confirm`, { method: 'POST', body: JSON.stringify({ name, lessons }) })
}

export function getCompiledBook(name: string): Promise<CompiledBook> {
    return json(`${API_BASE}/compiled/${encodeURIComponent(name)}`)
}

export function listCompiledBooks(): Promise<{ books: { name: string; conceptCount: number; chapters: number; degraded: boolean }[] }> {
    return json(`${API_BASE}/compiled`)
}
