import { describe, expect, it } from 'vitest'
import { applyTail, carryableText, looksLikeQuestion, mergeContinued, mergeSubQuestionDrafts, strayFigureBox, type Box } from './shared'
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

describe('mergeSubQuestionDrafts', () => {
    /**
     * 分层路径的拆散发生在版面那趟：(1)(2)(3) 被切成独立条目，
     * 各走一次内容抽取，到草稿层已是三份孤儿。实机上练习6
     * （科普读物折线图 + 三个小问）就是这么被拆的，孤儿小问还把
     * 图形规格的报错也带了出来。
     */
    it('相邻的小问草稿并回主题干，图用主干那张', () => {
        const merged = mergeSubQuestionDrafts([
            draft({ stem: '根据统计图回答下列问题．', answer: '', figureImage: 'CHART' }),
            draft({ key: 'k2', stem: '（1）四年级喜欢看科普读物的学生人数是多少？', answer: '57' }),
            draft({ key: 'k3', stem: '（2）丁丁是哪个年级的？', answer: '五年级' }),
        ])
        expect(merged).toHaveLength(1)
        expect(merged[0]!.stem).toContain('（2）丁丁')
        expect(merged[0]!.answer).toBe('57；五年级')
        expect(merged[0]!.figureImage).toBe('CHART')
    })

    it('第一份就以 (1) 开头的不动——那道题本来就长那样', () => {
        const merged = mergeSubQuestionDrafts([draft({ stem: '(1) 127×123. (2) 229×221.', answer: '15621；50609' })])
        expect(merged).toHaveLength(1)
    })

    it('正常的两道题不受影响', () => {
        expect(
            mergeSubQuestionDrafts([draft({ stem: '甲题', answer: '1' }), draft({ key: 'k2', stem: '乙题', answer: '2' })]),
        ).toHaveLength(2)
    })
})

describe('strayFigureBox：认领流落到续页的题干配图', () => {
    /**
     * 两个真实案例版面结构完全一样、真相相反（图都在"答案线"之上）：
     * 练习4 的折线图是题干配图（题干说了「如图」、还没有图），
     * 三个和尚的推演表是答案内容（题干不提图）。位置分不出，上一题的状态能。
     */
    const item = { figureBox: [0.64, 0.05, 0.9, 0.23] as Box, answerTop: 0.26 }

    it('上一题缺图且题干明说有图 → 认领', () => {
        const prev = { stem: '如图，是牛牛五次数学测验成绩的统计图．平均分是 ______ 分．' }
        expect(strayFigureBox(item, prev)).toEqual([0.64, 0.05, 0.9, 0.23])
    })

    it('题干不提图 → 不认领（三个和尚的推演表就是这样进的解析图）', () => {
        const prev = { stem: '口渴的三个和尚分别捧着一个水罐，最初老和尚的水最多' }
        expect(strayFigureBox(item, prev)).toBeUndefined()
    })

    it('上一题已经有图 → 不认领', () => {
        const prev = { stem: '如图，统计图如下', figureImage: 'HAS.jpg' }
        expect(strayFigureBox(item, prev)).toBeUndefined()
    })

    it('answerTop 是 0（整块都是答案）→ 不认领', () => {
        const prev = { stem: '如图，统计图如下' }
        expect(strayFigureBox({ ...item, answerTop: 0 }, prev)).toBeUndefined()
    })

    it('图的下边越过答案线时裁到线为止', () => {
        const prev = { stem: '如图，统计图如下' }
        expect(strayFigureBox({ figureBox: [0.6, 0.05, 0.9, 0.4] as Box, answerTop: 0.26 }, prev)).toEqual([
            0.6, 0.05, 0.9, 0.26,
        ])
    })
})
