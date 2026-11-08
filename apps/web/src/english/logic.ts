/**
 * 英语页的判定与状态推进：全部是纯函数，页面只负责画。
 *
 * 为什么要单独抽出来：这一页的核心不是样式，而是几条"错了就会骗孩子"的规矩——
 * 答错后重练不能算进度、没作答不能跳到下一张、原文依据只能在该题答对之后出现。
 * 这些规矩写在这里，被 *.test.ts 逐条钉住，改样式时不会顺手改坏。
 */
import {
    EnglishApiError,
    GENERIC_FAILURE,
    type PassageQuestion,
    type ReadingSummary,
    type VocabCard,
    type VocabDirection,
    type VocabStats,
    type VocabToday,
} from './api'

/* ────────────────────────── 词汇卡 ────────────────────────── */

export interface VocabTask {
    card: VocabCard
    direction: VocabDirection
    /** 复习＝以前见过，新词＝今天第一次见。界面分开说，孩子才知道自己在做什么 */
    kind: 'review' | 'new'
}

/**
 * 今天的词卡队列：先复习到期的，再学新词。
 *
 * 顺序是服务端口径（也写在 note 里）：先想起来旧的，再装新的——
 * 反过来会让孩子一上来就被生词压住，复习的卡到了晚上也没做。
 *
 * 同一个词只出一张：万一服务端把某个词同时算进复习和新词（数据新旧交替时可能），
 * 连着答两遍同一个词，孩子会以为自己刚才那次白答了。
 */
export function buildVocabQueue(batch: VocabToday): VocabTask[] {
    const seen = new Set<string>()
    const queue: VocabTask[] = []
    for (const item of batch.reviews) {
        if (seen.has(item.card.id)) continue
        seen.add(item.card.id)
        queue.push({ card: item.card, direction: item.direction, kind: 'review' })
    }
    for (const item of batch.newWords) {
        if (seen.has(item.card.id)) continue
        seen.add(item.card.id)
        queue.push({ card: item.card, direction: item.direction, kind: 'new' })
    }
    return queue
}

export interface VocabFace {
    /** 卡正面：en2zh 显示英文单词，zh2en 显示中文 */
    prompt: string
    /** 题目要求（"这个单词是什么意思？"） */
    ask: string
    placeholder: string
    /** 正面的文字是拉丁字母还是汉字：决定字号与字体，中文比英文占地方 */
    script: 'latin' | 'han'
}

export function vocabFace(task: VocabTask): VocabFace {
    return task.direction === 'en2zh'
        ? {
              prompt: task.card.en,
              ask: '看英文，说中文：这个词是什么意思？',
              placeholder: '写中文意思',
              script: 'latin',
          }
        : {
              prompt: task.card.zh,
              ask: '看中文，写英文：这个词用英语怎么写？',
              placeholder: '写英文单词',
              script: 'han',
          }
}

export type VocabVerdict = 'correct' | 'wrong'

export interface VocabSession {
    queue: VocabTask[]
    /** 当前卡在队列里的位置；等于 queue.length 表示这一轮做完了 */
    index: number
    /** 这一轮真正答对的张数（答错后重练答对算一次） */
    correct: number
    /** 已经翻过去的张数：进度条用，含"答错了但点了下一个" */
    passed: number
    /** 当前卡的判定；null = 还没交卷 */
    verdict: VocabVerdict | null
}

export type VocabAction =
    | { type: 'answered'; correct: boolean }
    | { type: 'retry' }
    | { type: 'next' }

export function createVocabSession(queue: VocabTask[]): VocabSession {
    return { queue, index: 0, correct: 0, passed: 0, verdict: null }
}

/**
 * 词卡状态机。三条规矩：
 *
 * 1. **一张卡只判一次**：判过之后再交卷不改判定、不重复计数（网络重试不该让"答对"变成两分）。
 * 2. **「再记一次」不推进度**：同一个词重写一遍，位置和已答对数都不动——
 *    否则答错→重写对了会被记成"两张卡都对"，统计就是在骗家长。
 * 3. **没作答就不能「下一个」**：跳过一张卡等于少练一张，却没人知道它被跳过了。
 */
export function vocabReducer(state: VocabSession, action: VocabAction): VocabSession {
    switch (action.type) {
        case 'answered': {
            if (state.verdict !== null) return state
            return {
                ...state,
                verdict: action.correct ? 'correct' : 'wrong',
                correct: state.correct + (action.correct ? 1 : 0),
            }
        }
        case 'retry': {
            // 只有答错才需要重练；已经答对的卡再"记一次"会把一次记忆算成两次
            if (state.verdict !== 'wrong') return state
            return { ...state, verdict: null }
        }
        case 'next': {
            if (state.verdict === null) return state
            return { ...state, index: state.index + 1, passed: state.passed + 1, verdict: null }
        }
        default:
            return state
    }
}

/** 当前该显示哪张卡；都做完了返回 null（界面此时给收尾状态，不留空白输入框） */
export function currentVocabTask(state: VocabSession): VocabTask | null {
    return state.queue[state.index] ?? null
}

export function vocabFinished(state: VocabSession): boolean {
    return state.index >= state.queue.length
}

/** 顶部进度：已学会多少 / 共多少（服务端 stats），以及今天要复习几张 */
export function masteredRatio(stats: VocabStats): number {
    if (stats.total <= 0) return 0
    return Math.max(0, Math.min(1, stats.mastered / stats.total))
}

/* ────────────────────────── 分级阅读 ────────────────────────── */

/** 一道阅读题的结果：答对留下依据，答错留下提示（服务端就是这么分两次给的） */
export type ReadingAnswer =
    | { status: 'correct'; reference: string; evidence: string }
    | { status: 'wrong'; hint: string }

/**
 * 当前该做第几题：**第一道还没答对的题**。
 *
 * 用"扫一遍找第一个没对的"而不是维护一个序号：孩子中途退出再进来、
 * 或者某道题答错重试，序号会跟真实进度对不上，而"哪道还没对"是永远说得清的。
 * 全对时返回 -1。
 */
export function activeQuestionIndex(
    questions: PassageQuestion[],
    answers: Record<string, ReadingAnswer>,
): number {
    return questions.findIndex((q) => answers[q.id]?.status !== 'correct')
}

export function passageDone(
    questions: PassageQuestion[],
    answers: Record<string, ReadingAnswer>,
): boolean {
    return questions.length > 0 && activeQuestionIndex(questions, answers) === -1
}

/**
 * 把原文按证据句子切开，命中的那一段标记出来。
 *
 * 为什么要在原文里高亮，而不止把依据单独印一行：阅读要教的是
 * "答案在原文的哪个位置"，孩子需要看到它在整段里的前后文。
 * 找不到就整段原样返回、不标——证据仍然会单独显示，不会因此丢东西。
 */
export function markEvidence(
    text: string,
    evidences: string[],
): { text: string; hit: boolean }[] {
    let parts: { text: string; hit: boolean }[] = [{ text, hit: false }]
    for (const evidence of evidences) {
        const needle = evidence.trim()
        if (!needle) continue
        const next: { text: string; hit: boolean }[] = []
        for (const part of parts) {
            if (part.hit) {
                next.push(part)
                continue
            }
            next.push(...splitOnce(part.text, needle))
        }
        parts = next
    }
    return parts
}

/** 在一段文字里找第一次出现的位置，切成 [前, 命中, 后] */
function splitOnce(text: string, needle: string): { text: string; hit: boolean }[] {
    const at = text.toLowerCase().indexOf(needle.toLowerCase())
    if (at < 0) return [{ text, hit: false }]
    const parts: { text: string; hit: boolean }[] = []
    if (at > 0) parts.push({ text: text.slice(0, at), hit: false })
    parts.push({ text: text.slice(at, at + needle.length), hit: true })
    const rest = text.slice(at + needle.length)
    if (rest) parts.push({ text: rest, hit: false })
    return parts
}

/** 列表里一行短文的说明：级别 · 词数 · 题数 */
export function passageMeta(passage: ReadingSummary): string {
    return `${passage.level} · ${passage.words} 词 · ${passage.questionCount} 题`
}

/** 列表里一篇短文的完成度：说清"读到哪儿"，不是只给个百分比 */
export function passageStatus(passage: ReadingSummary): string {
    if (passage.done) return '读完了'
    if (passage.answered > 0) return `已答 ${passage.answered} / ${passage.questionCount} 题`
    return '还没读'
}

/* ────────────────────────── 失败怎么说 ────────────────────────── */

/**
 * 把一次失败翻译成给孩子的一句话。
 *
 * 403 是**家长的决定**，不是故障——照服务端给的那句话说出来（"家长把「英语」关掉了……"），
 * 孩子才知道该去找谁；任何情况下都不把「HTTP 403」这种编号甩给孩子。
 * 其余情况（断网、500、返回体不是 JSON）统一一句"暂时打不开，稍后再试"：
 * 这是我们的问题，不该让孩子读一串技术细节。
 */
export function explainEnglishFailure(err: unknown): string {
    if (err instanceof EnglishApiError) {
        if (err.status === 403) return err.message || GENERIC_FAILURE
        return GENERIC_FAILURE
    }
    return GENERIC_FAILURE
}

/** 这次失败是不是"家长关掉了英语"（整页要拦住，而不是让他在两个 tab 里白点） */
export function isModuleBlocked(err: unknown): boolean {
    return err instanceof EnglishApiError && err.status === 403
}
