import { describe, expect, it } from 'vitest'
import { applyTail, carryableText, looksLikeQuestion, mergeContinued } from './shared'
import type { Draft } from './shared'

/**
 * 跨页合并。讲义里一道题常被页边切开，实机上两种切法都出过错：
 * ① 一题两问，第二问在下一页 → 第二问抽不出来
 * ② 教师版的解答落到下一页 → 那张解法图被当成题干配图
 *
 * ② 的机制在这里：合并时若整个丢掉上一半，题干图就跟着换成了
 * 下一页开头那张——而那张多半是解法图。
 */
const draft = (over: Partial<Draft> = {}): Draft => ({
    key: 'k1',
    stem: '',
    answer: '',
    answerType: 'numeric',
    difficulty: 2,
    level: 'elementary_upper',
    nodes: [],
    ...over,
})

describe('mergeContinued', () => {
    it('题干图以先出现的那张为准——下一页开头那张多半是解法图', () => {
        const prev = draft({ stem: '如图，两个梯形重叠', figureImage: 'STEM_IMG' })
        const next = draft({ key: 'k2', stem: '如图，两个梯形重叠（2）求阴影面积', figureImage: 'SOLUTION_IMG' })
        const out = mergeContinued(prev, next)
        expect(out.figureImage).toBe('STEM_IMG')
    })

    it('下一页裁到的解法图进 analysisImage', () => {
        const prev = draft({ stem: '如图，两个梯形重叠', figureImage: 'STEM_IMG' })
        const next = draft({ key: 'k2', stem: '如图，两个梯形重叠', analysisImage: 'SOLUTION_IMG' })
        expect(mergeContinued(prev, next).analysisImage).toBe('SOLUTION_IMG')
    })

    it('模型照着 carryOver 拼好了就用它拼的', () => {
        const prev = draft({ stem: '小明有12个苹果，' })
        const next = draft({ key: 'k2', stem: '小明有12个苹果，平均分给4人，每人几个？' })
        expect(mergeContinued(prev, next).stem).toBe('小明有12个苹果，平均分给4人，每人几个？')
    })

    it('模型没拼（只读了下半页）时自己接上——上半截题干不能凭空消失', () => {
        const prev = draft({ stem: '小明有12个苹果，平均分给4人' })
        const next = draft({ key: 'k2', stem: '（2）如果每人多分2个，还剩几个？' })
        const out = mergeContinued(prev, next)
        expect(out.stem).toContain('小明有12个苹果')
        expect(out.stem).toContain('（2）如果每人多分2个')
    })

    it('一题两问时两个答案都留住', () => {
        const prev = draft({ stem: '题干', answer: '3' })
        const next = draft({ key: 'k2', stem: '题干', answer: '5' })
        expect(mergeContinued(prev, next).answer).toBe('3；5')
    })

    it('两半答案相同时不重复写一遍', () => {
        const prev = draft({ stem: '题干', answer: '3' })
        const next = draft({ key: 'k2', stem: '题干', answer: '3' })
        expect(mergeContinued(prev, next).answer).toBe('3')
    })

    it('只有一半有答案时用那一半', () => {
        const prev = draft({ stem: '题干', answer: '' })
        const next = draft({ key: 'k2', stem: '题干', answer: '5' })
        expect(mergeContinued(prev, next).answer).toBe('5')
    })

    it('任一半的答案是模型猜的，合并后仍要标记', () => {
        const prev = draft({ stem: '题干', answer: '3', answerUnverified: true })
        const next = draft({ key: 'k2', stem: '题干', answer: '5' })
        expect(mergeContinued(prev, next).answerUnverified).toBe(true)
    })

    it('下半页没认出知识点时沿用上半页的', () => {
        const prev = draft({ stem: '题干', nodes: [{ nodeId: 'perimeter' }] })
        const next = draft({ key: 'k2', stem: '题干', nodes: [] })
        expect(mergeContinued(prev, next).nodes).toEqual([{ nodeId: 'perimeter' }])
    })
})

describe('applyTail', () => {
    /**
     * 续页开头那块（整块是【答案】【解析】）读出来的东西，要补回上一页那道题。
     *
     * 关键是谁说了算：上一页那道题此刻的答案多半是模型自己算的
     * （它只看到题干，没看到答案框），而这一块才是讲义印着的那个。
     */
    it('讲义印的答案顶掉模型猜的，并摘掉"猜的"标记', () => {
        const prev = draft({ stem: '数三角形', answer: '48', answerUnverified: true })
        const out = applyTail(prev, { answer: '54' })
        expect(out.answer).toBe('54')
        expect(out.answerUnverified).toBe(false)
    })

    it('上一页没答案时直接补上', () => {
        const out = applyTail(draft({ stem: '题干', answer: '' }), { answer: '54' })
        expect(out.answer).toBe('54')
    })

    it('一题两问、两半都是讲义给的 → 两个答案都留住', () => {
        const prev = draft({ stem: '题干', answer: '3' })
        expect(applyTail(prev, { answer: '5' }).answer).toBe('3；5')
    })

    it('两半答案相同时不写成「3；3」', () => {
        expect(applyTail(draft({ stem: '题干', answer: '3' }), { answer: '3' }).answer).toBe('3')
    })

    it('续页那块自己也没读出答案时，保持原样不乱改', () => {
        const prev = draft({ stem: '题干', answer: '48', answerUnverified: true })
        const out = applyTail(prev, { analysis: '分类计数' })
        expect(out.answer).toBe('48')
        expect(out.answerUnverified).toBe(true)
        expect(out.analysis).toBe('分类计数')
    })

    it('续页那块的答案也是模型算的，就不顶掉上一页的', () => {
        const prev = draft({ stem: '题干', answer: '48' })
        const out = applyTail(prev, { answer: '54', answerUnverified: true })
        expect(out.answer).toBe('48')
    })
})

describe('looksLikeQuestion', () => {
    /**
     * 页脚那条「只有题号」的窄带照样会被抽一遍——不丢它，是因为判错时
     * 会把页底一道开头很短的真题整条扔掉。代价是偶尔抽出个题号，这里滤掉。
     */
    it.each([
        ['就是题号', '练习9', '练习9'],
        ['题号带标点', '练习9．', '练习9'],
        ['太短', '如图', undefined],
        ['空的', '   ', undefined],
    ])('滤掉不是题的：%s', (_why, stem, label) => {
        expect(looksLikeQuestion(draft({ stem }), label)).toBe(false)
    })

    it.each([
        ['正常题干', '如图，在平行四边形ABCD中，CD=8厘米，AE=3厘米，求面积'],
        ['开头很短但成句', '两个边长为10厘米的正方形互相错开3厘米'],
    ])('留下真题：%s', (_why, stem) => {
        expect(looksLikeQuestion(draft({ stem }), '练习4')).toBe(true)
    })

    it('题号相同但后面有题干的，是真题', () => {
        expect(looksLikeQuestion(draft({ stem: '练习9 牛牛拿到的题目：两个相同的直角三角形重叠' }), '练习9')).toBe(
            true,
        )
    })
})

describe('carryableText', () => {
    /**
     * 上一页页脚那条的文字要不要当作"这道题的开头"传下去。
     * 传错了比不传更坏：实测传过去一句「二、转动数学大脑」，
     * 提示词要求模型"把它与本图的内容拼成完整题干"，模型直接答不出题来。
     */
    it('像题干的才传', () => {
        expect(carryableText('小明有12个苹果，平均分给4个人', '练习5')).toBe('小明有12个苹果，平均分给4个人')
    })

    it.each([
        ['题号本身', '练习9', '练习9'],
        ['章节标题', '二、转动数学大脑', '练习7'],
        ['三两个字', '如图', '练习5'],
        ['空的', '   ', '练习5'],
    ])('不像题干的不传：%s', (_why, preview, label) => {
        expect(carryableText(preview, label)).toBeUndefined()
    })
})
