import type { AlignResult, CompileJob, CompiledBook } from './api'

/**
 * 教材页里"要做判断"的那几件事，抽成纯函数。
 *
 * 不放在组件里是有原因的：这个仓库没有 jsdom、"渲染一个组件再点一下"这种测试
 * 在这里既慢又脆。而真正会出错的从来不是渲染，是**默认选中了什么、确认时提交了什么、
 * 什么时候算结束**——这些都能在 node 里验清楚。
 */

/**
 * 对齐清单的默认选中：每个概念取候选第一名，没有候选的留空。
 *
 * 为什么默认选第一名而不是全空：家长最常见的动作是"按它给的来"，
 * 全空逼他逐条点一遍，反而会让他不看就乱点。默认选中 + 每条都能改，才是可用的默认。
 */
export function presetChoices(items: AlignResult['items']): Record<string, string> {
    const choices: Record<string, string> = {}
    for (const item of items) {
        const top = item.candidates[0]
        if (top) choices[item.conceptId] = top.nodeId
    }
    return choices
}

/**
 * 把页面上的选择变成 confirm 的 lessons。
 *
 * 空选择必须被剔除，而不是发一个 `nodeId: ""` 上去——服务端会回 422，
 * 而家长看到的是"确认失败"，根本不知道是哪一条没选。
 */
export function toLessons(choice: Record<string, string>): { conceptId: string; nodeId: string }[] {
    return Object.entries(choice)
        .filter(([conceptId, nodeId]) => Boolean(conceptId) && Boolean(nodeId))
        .map(([conceptId, nodeId]) => ({ conceptId, nodeId }))
}

/** 顶部那行覆盖情况：没有产物时返回 null，页面据此不显示这一行 */
export function coverageLabel(coverage: CompiledBook['coverage'] | undefined): string | null {
    if (!coverage || coverage.chapters === 0) return null
    return `${coverage.chaptersWithConcepts}/${coverage.chapters} 章出概念 · ${coverage.concepts} 个概念（${coverage.verifiedConcepts} 个有可定位出处）`
}

export interface PollOptions {
    /** 轮询间隔；测试里给 0 */
    intervalMs?: number
    /** 最多轮询多少次：不许无限等下去（服务端任务可能永远停在 running） */
    maxTicks?: number
    sleep?: (ms: number) => Promise<void>
    onProgress?: (job: CompileJob) => void
}

/**
 * 等一个编译任务跑完。
 *
 * 三件事必须做对：任务失败要**立刻**把服务端的错误抛出来（而不是继续轮询到超时）；
 * 轮询有上限；每一次进度都回调给页面，否则十几分钟的编译就是个哑进度条。
 */
export async function pollCompileJob(
    fetchJob: (jobId: string) => Promise<CompileJob>,
    jobId: string,
    options: PollOptions = {},
): Promise<CompileJob> {
    const { intervalMs = 1500, maxTicks = 1200, sleep = defaultSleep, onProgress } = options
    for (let tick = 0; tick < maxTicks; tick++) {
        const job = await fetchJob(jobId)
        onProgress?.(job)
        if (job.status === 'failed') throw new Error(job.error ?? '编译失败')
        if (job.status === 'done') return job
        await sleep(intervalMs)
    }
    throw new Error(`编译任务 ${jobId} 迟迟没有结束（已等待 ${maxTicks} 次轮询）`)
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
