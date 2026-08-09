/**
 * 录题模块共享类型与工具：Draft 归一化、文件读取、错误信息提取。
 * 供单发流程（IngestPage）、批量流程（BatchPanel）与抽检（ReviewTab）复用。
 */

export type AnswerType = 'numeric' | 'expression' | 'steps'
export type Level = 'elementary_lower' | 'elementary_upper' | 'middle' | 'high' | 'advanced'

export const LEVEL_LABELS: Record<Level, string> = {
    elementary_lower: '小学低年级',
    elementary_upper: '小学高年级',
    middle: '初中',
    high: '高中',
    advanced: '进阶',
}

export const ANSWER_TYPE_LABELS: Record<AnswerType, string> = {
    numeric: '数值',
    expression: '表达式',
    steps: '解答步骤',
}

export interface NodeSuggestion {
    nodeId: string
    confidence?: number
}

/** 客户端草稿：由 upload/batch 返回的 drafts 归一化而来，可编辑 */
export interface Draft {
    key: string
    stem: string
    answer: string
    answerType: AnswerType
    difficulty: number
    level: Level
    options?: string[]
    analysis?: string
    nodes: NodeSuggestion[]
}

export interface ConfirmResult {
    written: number
    skippedDuplicates: number
    issues: string[]
}

let draftSeq = 0

/** 容错归一化：suggestedNodeIds 可能是 string[] 或 {nodeId,confidence}[]，也可能落在 nodeIds */
export function normalizeNodes(raw: unknown): NodeSuggestion[] {
    if (!Array.isArray(raw)) return []
    const out: NodeSuggestion[] = []
    for (const item of raw) {
        if (typeof item === 'string') {
            out.push({ nodeId: item })
        } else if (item && typeof item === 'object') {
            const o = item as { nodeId?: unknown; id?: unknown; confidence?: unknown }
            const nodeId = typeof o.nodeId === 'string' ? o.nodeId : typeof o.id === 'string' ? o.id : null
            if (nodeId) {
                out.push({
                    nodeId,
                    confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
                })
            }
        }
    }
    return out
}

export function normalizeDraft(raw: unknown): Draft | null {
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    if (typeof o.stem !== 'string' || !o.stem.trim()) return null
    const answerType: AnswerType =
        o.answerType === 'expression' || o.answerType === 'steps' ? o.answerType : 'numeric'
    const level: Level =
        typeof o.level === 'string' && o.level in LEVEL_LABELS ? (o.level as Level) : 'elementary_upper'
    const difficulty =
        typeof o.difficulty === 'number' ? Math.min(5, Math.max(1, Math.round(o.difficulty))) : 3
    return {
        key: `draft-${++draftSeq}`,
        stem: o.stem,
        answer: typeof o.answer === 'string' ? o.answer : '',
        answerType,
        difficulty,
        level,
        options: Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : undefined,
        analysis: typeof o.analysis === 'string' ? o.analysis : undefined,
        nodes: normalizeNodes(o.suggestedNodeIds ?? o.nodeIds),
    }
}

export function todayString(): string {
    const d = new Date()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${mm}-${dd}`
}

export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('文件读取失败'))
        reader.readAsDataURL(file)
    })
}

/** 从失败响应中提取可读错误；notReadyHint 用于 501（流水线未配置）场景 */
export async function extractErrorMessage(res: Response, notReadyHint: string): Promise<string> {
    let serverMsg = ''
    try {
        const body = (await res.json()) as { error?: unknown; message?: unknown }
        serverMsg = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : ''
    } catch {
        /* 非 JSON 响应 */
    }
    if (res.status === 501) {
        return serverMsg ? `${notReadyHint}（${serverMsg}）` : notReadyHint
    }
    return serverMsg || `请求失败 (HTTP ${res.status})`
}

export const inputCls =
    'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-300'
