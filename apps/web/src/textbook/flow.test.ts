import { describe, expect, it, vi } from 'vitest'
import { coverageLabel, pollCompileJob, presetChoices, toLessons } from './flow'
import type { AlignResult, CompileJob } from './api'

/**
 * 教材页里会做判断的几件事：默认选什么、提交什么、什么时候算结束。
 * 这些错了家长是看不出来的——他只会觉得"确认没成功"。
 */

const alignItems = (): AlignResult['items'] => [
    {
        conceptId: 'c1',
        conceptTitle: '通分',
        status: 'pending',
        candidates: [
            { nodeId: 'fraction-arithmetic', nodeName: '分数四则运算', score: 62, reasons: ['通分'] },
            { nodeId: 'fraction', nodeName: '分数初步认识', score: 40, reasons: [] },
        ],
    },
    // 图谱里对不上的概念：不该被默认选中，否则确认时会提交一个空洞的映射
    { conceptId: 'c2', conceptTitle: 'am/is/are', status: 'pending', candidates: [] },
]

describe('presetChoices', () => {
    it('每个概念默认取候选第一名，没有候选的留空', () => {
        expect(presetChoices(alignItems())).toEqual({ c1: 'fraction-arithmetic' })
    })
})

describe('toLessons', () => {
    it('剔掉空选择，只提交真的选了节点的', () => {
        const choice = { c1: 'fraction-arithmetic', c2: '', c3: 'triangle' }
        expect(toLessons(choice)).toEqual([
            { conceptId: 'c1', nodeId: 'fraction-arithmetic' },
            { conceptId: 'c3', nodeId: 'triangle' },
        ])
    })

    it('全空时提交空数组——页面据此提示"至少选一个"，而不是发一个 422 上去', () => {
        expect(toLessons({ c1: '', c2: '' })).toEqual([])
    })
})

describe('coverageLabel', () => {
    it('有产物时给一行覆盖情况', () => {
        expect(coverageLabel({ chapters: 12, chaptersWithConcepts: 11, concepts: 40, verifiedConcepts: 33 })).toBe(
            '11/12 章出概念 · 40 个概念（33 个有可定位出处）',
        )
    })

    it('没切出章节时不显示（而不是显示 0/0）', () => {
        expect(coverageLabel({ chapters: 0, chaptersWithConcepts: 0, concepts: 0, verifiedConcepts: 0 })).toBeNull()
        expect(coverageLabel(undefined)).toBeNull()
    })
})

describe('pollCompileJob', () => {
    const job = (status: CompileJob['status'], extra: Partial<CompileJob> = {}): CompileJob => ({
        id: 'j1',
        status,
        progress: { stage: 'compile', current: 1, total: 3 },
        result: null,
        error: null,
        ...extra,
    })

    it('跑到 done 就返回，并把每次进度回调出去', async () => {
        const seq = [job('running'), job('running', { progress: { current: 2, total: 3 } }), job('done')]
        const fetchJob = vi.fn(async () => seq.shift()!)
        const seen: (number | undefined)[] = []

        const done = await pollCompileJob(fetchJob, 'j1', {
            intervalMs: 0,
            sleep: async () => {},
            onProgress: (j) => seen.push(j.progress.current),
        })

        expect(done.status).toBe('done')
        expect(seen).toEqual([1, 2, 1])
        expect(fetchJob).toHaveBeenCalledTimes(3)
    })

    it('任务失败就立刻抛出服务端的错误，不再继续轮询', async () => {
        const fetchJob = vi.fn(async () => job('failed', { error: '模型端点不可用' }))
        await expect(pollCompileJob(fetchJob, 'j1', { intervalMs: 0, sleep: async () => {} })).rejects.toThrow(
            '模型端点不可用',
        )
        expect(fetchJob).toHaveBeenCalledTimes(1)
    })

    it('一直 running 也有上限，不会无限等下去', async () => {
        const fetchJob = vi.fn(async () => job('running'))
        await expect(
            pollCompileJob(fetchJob, 'j1', { intervalMs: 0, maxTicks: 3, sleep: async () => {} }),
        ).rejects.toThrow('迟迟没有结束')
        expect(fetchJob).toHaveBeenCalledTimes(3)
    })
})
