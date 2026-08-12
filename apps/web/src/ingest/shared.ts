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
    /**
     * 原题原图（data URL）：从讲义页上裁下来的那一块。
     * 这是配图的主表示——它就是原图，不存在重新理解的风险。
     */
    figureImage?: string
    /**
     * 【解析】里那张图（data URL）。老师画的解法图——只在讲解时用，
     * 做题时绝不给孩子看：那张图往往就是解法本身。
     */
    analysisImage?: string
    /** 几何题的配图规格（已过服务端门禁）；原样带回确认，入库前再验一次 */
    figure?: unknown
    /** 配图被丢弃的原因 */
    figureRejected?: string
    /** 模型提了但图谱里没有的知识点说法——它同时也是"我们缺哪个节点"的线索 */
    droppedSuggestions?: string[]
    /**
     * 答案是模型自己解的，材料里没有。
     * 学生版讲义不印答案，实测同一道数三角形的题模型两次给出 48 和 84——
     * 这种数进了库，孩子做错会被判对、做对会被判错，所以必须先让家长看见。
     */
    answerUnverified?: boolean
    /** 答案不唯一（巧填算符这类多解题）：对不上时交给家长，不判错 */
    answerUnique?: boolean
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
        figureImage: typeof o.figureImage === 'string' ? o.figureImage : undefined,
        analysisImage: typeof o.analysisImage === 'string' ? o.analysisImage : undefined,
        figure: o.figure,
        figureRejected: typeof o.figureRejected === 'string' ? o.figureRejected : undefined,
        droppedSuggestions: Array.isArray(o.droppedSuggestions)
            ? o.droppedSuggestions.filter((x): x is string => typeof x === 'string')
            : undefined,
        answerUnverified: o.answerUnverified === true,
        answerUnique: o.answerUnique === false ? false : undefined,
    }
}

/**
 * 把跨页的两半拼成一道题。
 *
 * 讲义里一道题常被页边切开：题干在上一页、第二问或【解析】在下一页。
 * 内容那趟已经拿到了上一页的题干（carryOver）并拼出完整题面，
 * 但**图不能这么处理**——下一页开头那张图多半是上一页那道题的解法图，
 * 拿它当题干图，等于把解法直接摆在孩子面前。
 * 实机上就是这么错的：合并时整个丢掉上一半，图跟着换成了第二页那张。
 *
 * 所以：题干图以先出现的那张为准，后出现的一律进解析图。
 */
export function mergeContinued(prev: Draft, next: Draft): Draft {
    // 模型没照着 carryOver 拼（第二半太短、或压根没提上一半）时自己接上，
    // 否则上一页那半截题干就凭空消失了
    const head = prev.stem.slice(0, 12)
    const stem = next.stem.includes(head) ? next.stem : `${prev.stem}\n${next.stem}`
    // 一题两问时两半各有一个答案，都要留住
    const answers = [prev.answer, next.answer].map((a) => a.trim()).filter(Boolean)
    const answer = [...new Set(answers)].join('；')
    return {
        ...next,
        key: prev.key,
        stem,
        answer,
        nodes: next.nodes.length > 0 ? next.nodes : prev.nodes,
        analysis: next.analysis ?? prev.analysis,
        options: next.options ?? prev.options,
        // 题干图只认先出现的那张（见上）
        figureImage: prev.figureImage ?? next.figureImage,
        analysisImage: prev.analysisImage ?? next.analysisImage,
        answerUnverified: prev.answerUnverified || next.answerUnverified,
    }
}

/** 续页开头那块（整块是【答案】【解析】）读出来的东西 */
export interface QuestionTail {
    answer?: string
    answerUnverified?: boolean
    analysis?: string
    hasFigure?: boolean
}

/**
 * 把续页开头那块的答案与解析补回上一页那道题。
 *
 * 关键是**谁说了算**：上一页那道题此刻的答案多半是模型自己算的
 * （它只看到题干，没看到答案框），而续页这一块才是讲义印着的那个。
 * 所以讲义读到的答案优先，并且把"模型猜的"这个标记摘掉——
 * 它已经不是猜的了。
 */
export function applyTail(prev: Draft, tail: QuestionTail): Draft {
    const fromMaterial = Boolean(tail.answer?.trim()) && !tail.answerUnverified
    const tailAnswer = tail.answer?.trim() ?? ''
    let answer = prev.answer
    let answerUnverified = prev.answerUnverified

    if (fromMaterial) {
        // 上一半的答案也是讲义给的、且与这半不同 → 一题两问，两个都留住
        answer =
            prev.answer.trim() && !prev.answerUnverified && prev.answer.trim() !== tailAnswer
                ? `${prev.answer.trim()}；${tailAnswer}`
                : tailAnswer
        answerUnverified = false
    } else if (tailAnswer && !prev.answer.trim()) {
        answer = tailAnswer
        answerUnverified = tail.answerUnverified
    }

    return {
        ...prev,
        answer,
        answerUnverified,
        analysis: tail.analysis ?? prev.analysis,
    }
}

/**
 * 抽出来的这份像不像一道题。
 *
 * 页脚那条「只有题号」的窄带照样会被抽一遍（不丢它是为了不误伤真题），
 * 抽出来往往就是题号本身或一句残句。这类东西不该进题库——
 * 家长抽检时看到一条「练习9」会以为系统坏了。
 *
 * 判据从宽：只滤掉明显不是题的。宁可放进来一条怪的（人看得见、删得掉），
 * 也不要因为判得太严把真题滤没了——那是看不见的。
 */
export function looksLikeQuestion(draft: Draft, label?: string): boolean {
    const stem = draft.stem.trim()
    if (stem.length < 8) return false
    // 就是题号本身（可能带个标点）
    const bare = stem.replace(/[\s.．、:：]/g, '')
    if (label && bare === label.replace(/[\s]/g, '')) return false
    if (/^(练习|例题?|第)\s*\d+\s*$/.test(bare)) return false
    return true
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

/** 卡片内输入框：与 .input-hero 同源（rule 边框 / beam 聚焦），尺寸收紧一档 */
export const inputCls =
    'w-full rounded-[10px] border border-rule bg-plate px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-beam focus:ring-2 focus:ring-beam-wash transition-colors'

/** 文件选择器：控件半径 10px、beam 语义色，单发与批量共用 */
export const fileInputCls =
    'mx-auto block text-sm text-ink-soft file:mr-3 file:rounded-[8px] file:border-0 file:bg-beam-wash file:px-4 file:py-1.5 file:text-sm file:font-medium file:text-beam hover:file:bg-beam/15'

/** 虚线投放区：批量与单发上传共用 */
export const dropzoneCls =
    'rounded-[10px] border-2 border-dashed border-rule bg-paper p-6 text-center'
