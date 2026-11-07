import type { KnowledgeNode, SceneSpec } from "@mathtutor/schema";
import type { GraphIndex } from "@mathtutor/knowledge";
import { buildPauseContext, redactAnswers } from "@mathtutor/core";
import { practiceReady, type QuestionStore } from "../questions.js";
import type { Question } from "@mathtutor/schema";

/**
 * 组课（compose 模式）：知识节点 + 题库 → 一节可以离线讲完的课。
 *
 * 为什么这次不用模型：PLAN 把课堂分成两条路——compose（确定性、离线可用）与
 * generate（模型生成、失败退回 compose）。**只有把 compose 先做对，降级才有意义**：
 * 没有确定性的那一档，"模型挂了怎么办"根本没有答案，只有一句"那就重试"。
 *
 * 三条硬规矩，都来自教学宪法：
 * 1. 每一拍的旁白都得能落在知识点档案上（summary / whatIsIt / applications），
 *    没有材料就不出这一拍——不编。
 * 2. 暂停提问的上下文里**不许留下这道题的答案**（数字是整词匹配，见 redact）。
 * 3. 对外 JSON 里没有 answer / analysis / salt / contentHash：课堂不是题库接口，
 *    孩子手里的数据不该包含判卷依据。
 */

export type LessonBeatRole = "intro" | "concept" | "example" | "check" | "summary";

/** 发给孩子的题目视图：只有做题需要的东西，一个字段都不多 */
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
    /** 整节课的画面：一拍一个 scene beat（播放器按 index 拨拍） */
    scene: SceneSpec
    /** 与 scene.scenes 一一对应的旁白（播放器把它画成字幕） */
    narrations: string[]
    /** 在第几拍停下提问；-1 表示这节课没有可用的题（照样能讲完） */
    pauseBeatIndex: number
    question: LessonQuestion | null
    /** 有多少拍是"知识点档案里真有话可说"的，用于家长判断课的质量 */
    materialBeats: number
}

/** 一句旁白最多这么长：字幕不是讲义，长句子要拆 */
const MAX_NARRATION_CHARS = 120

/** 把一段档案文字拆成若干句能当旁白的话 */
function sentences(text: string): string[] {
    return text
        .split(/[。！？!?；;\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 4)
        .map((s) => (s.length > MAX_NARRATION_CHARS ? `${s.slice(0, MAX_NARRATION_CHARS)}…` : s))
}

/**
 * 从这道题派生"答案长什么样"，用于把旁白里可能出现的答案剔掉。
 *
 * 只取答案本身：分析（analysis）本来就不下发，别把不需要的东西也塞进剔除表——
 * 剔得越宽，越容易把正常讲解句剔成断句。
 */
function lessonAnswers(question: Question | null): { questionId: string; answer: string }[] {
    if (!question) return []
    const answer = question.answer?.trim()
    return answer ? [{ questionId: question.id, answer }] : []
}

/** 挑一道能用作课堂提问的题：题面干净、难度别拔太高、答案不是"待定" */
export function pickLessonQuestion(store: QuestionStore, nodeId: string): Question | null {
    const candidates = (store.byNode.get(nodeId) ?? []).filter(practiceReady)
    if (candidates.length === 0) return null
    const scored = [...candidates].sort((a, b) => {
        // 课堂提问要的是"刚讲过的东西用没用上"，不是难题闯关
        const byDifficulty = (a.difficulty ?? 3) - (b.difficulty ?? 3)
        if (byDifficulty !== 0) return byDifficulty
        return (b.nodeIds?.length ?? 0) - (a.nodeIds?.length ?? 0)
    })
    return scored[0] ?? null
}

export function toLessonQuestion(question: Question): LessonQuestion {
    return {
        questionId: question.id,
        stem: question.stem,
        answerType: question.answerType,
        options: question.options ?? null,
        difficulty: question.difficulty,
        nodeIds: question.nodeIds,
        // 刻意不包含：answer / analysis / salt / contentHash / figureImage 之外的判卷依据
    }
}

/**
 * 组一节 compose 课。
 *
 * 拍序：引入 → 概念（最多两拍）→ 例子（有才出）→ 提问 → 小结。
 * 提问插在例子之后、小结之前：讲完并用过一个例子再问，才是"检查理解"而不是"考预习"。
 */
export function composeLesson(
    nodeId: string,
    index: GraphIndex,
    store: QuestionStore,
): ComposedLesson | null {
    const node: KnowledgeNode | undefined = index.getNode(nodeId)
    if (!node) return null

    const question = pickLessonQuestion(store, nodeId)
    const answers = lessonAnswers(question)

    const beats: { role: LessonBeatRole; narration: string }[] = []
    const push = (role: LessonBeatRole, text: string | undefined) => {
        if (!text) return
        for (const s of sentences(text)) {
            // 剔答案：旁白里出现答案，等于把题提前做完了
            const narration = redactAnswers(s, answers).text.trim()
            if (narration) beats.push({ role, narration })
        }
    }

    push("intro", node.summary ? `${node.name}：${node.summary}` : node.name)
    const conceptBeats = beats.length
    push("concept", node.whatIsIt)
    // 档案没写 whatIsIt 时，用演变/用途补一拍，总比只有一句标题强
    if (beats.length === conceptBeats) {
        push("concept", node.evolvesTo?.[0]?.how)
        push("concept", node.applications?.[0]?.detail)
    }
    push("example", node.applications?.[0]?.title ? `${node.applications[0].title}：${node.applications[0].detail}` : undefined)

    const pauseBeatIndex = question ? beats.length : -1
    if (question) beats.push({ role: "check", narration: "先停一下：这道题你会怎么想？" })

    push("summary", node.bigPicture ?? node.summary)

    if (beats.length === 0) return null

    const scene: SceneSpec = {
        visual_thesis: `${node.name}：${node.summary ?? ""}`.trim(),
        // 板书只有字幕、没有图元：宁可空着，也不画一张和知识点无关的装饰图
        // （这正是 VISUAL_SEMANTICS 里 "empty-target" 那条要拦的东西的镜像——
        //  有图无义同样不行，所以没材料时就不给图元）
        visual_objects: [],
        scenes: beats.map((beat) => ({
            role: beat.role,
            teaching_line: beat.narration,
            actions: [],
        })),
    }

    return {
        nodeId,
        nodeName: node.name,
        scene,
        narrations: beats.map((b) => b.narration),
        pauseBeatIndex,
        question: question ? toLessonQuestion(question) : null,
        materialBeats: beats.filter((b) => b.role !== "check").length,
    }
}

/**
 * 暂停提问时的上下文：只给"到这一拍为止"的讲解。
 *
 * 传空的答案表是有意的：旁白在组课时**已经**逐句剔除过答案（见 composeLesson），
 * 这里再拿一个假答案去剔，只会制造"看起来剔过"的错觉。真正的门在组装那一步，
 * 有测试盯着（旁白里不许出现这道题的答案）。
 */
export function pauseContextFor(lesson: ComposedLesson): string {
    if (lesson.pauseBeatIndex < 0) return ""
    return buildPauseContext(lesson.narrations, lesson.pauseBeatIndex, [])
}

/** 有哪些知识点可以开课：题库里真有"能发给孩子"的题的那些 */
export function availableLessons(
    index: GraphIndex,
    store: QuestionStore,
    limit = 24,
): { nodeId: string; name: string; stage: string; questionCount: number }[] {
    const out: { nodeId: string; name: string; stage: string; questionCount: number }[] = []
    for (const node of index.graph.nodes) {
        const count = (store.byNode.get(node.id) ?? []).filter(practiceReady).length
        if (count === 0) continue
        out.push({ nodeId: node.id, name: node.name, stage: node.stage, questionCount: count })
    }
    // 先给孩子最小学段的（课堂从低年级开始最稳），同段按题量多的在前
    const order = ["elementary_lower", "elementary_upper", "middle", "high", "advanced"]
    out.sort((a, b) => {
        const byStage = (order.indexOf(a.stage) + 1 || 99) - (order.indexOf(b.stage) + 1 || 99)
        if (byStage !== 0) return byStage
        return b.questionCount - a.questionCount
    })
    return out.slice(0, limit)
}
