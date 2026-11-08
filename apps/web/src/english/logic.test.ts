import { describe, expect, it } from 'vitest'

import { EnglishApiError, GENERIC_FAILURE, type VocabToday } from './api'
import {
    activeQuestionIndex,
    buildVocabQueue,
    createVocabSession,
    currentVocabTask,
    explainEnglishFailure,
    isModuleBlocked,
    markEvidence,
    masteredRatio,
    passageDone,
    passageMeta,
    passageStatus,
    vocabFace,
    vocabFinished,
    vocabReducer,
    type ReadingAnswer,
    type VocabSession,
} from './logic'

/**
 * 英语页的判定逻辑。
 *
 * 这一页最容易坏的地方不是样式，是"进度"和"依据"：
 * 答错后重练被记成一次答对、没作答就跳到下一张、答错却把原文亮出来——
 * 这三件事都不会报错，但会让孩子和家长都看到一份假的数字。
 */

const card = (id: string, zh: string, en: string) => ({
    id,
    zh,
    en,
    cefr: 'A1',
    example: `This is ${en}.`,
})

function batch(overrides: Partial<VocabToday> = {}): VocabToday {
    return {
        newWords: [
            { card: card('w-new', '学校', 'school'), direction: 'en2zh' },
            { card: card('w-new2', '老师', 'teacher'), direction: 'zh2en' },
        ],
        reviews: [{ card: card('w-old', '书', 'book'), direction: 'zh2en', cardId: 'rc-1' }],
        stats: { total: 40, learning: 3, mastered: 12, dueToday: 1 },
        note: '先复习到期的，再学新词。',
        ...overrides,
    }
}

/** 走一步状态机（测试里读起来像一句话） */
function step(state: VocabSession, action: Parameters<typeof vocabReducer>[1]): VocabSession {
    return vocabReducer(state, action)
}

describe('buildVocabQueue', () => {
    it('先复习到期的，再学新词', () => {
        const queue = buildVocabQueue(batch())
        expect(queue.map((t) => t.card.id)).toEqual(['w-old', 'w-new', 'w-new2'])
        expect(queue.map((t) => t.kind)).toEqual(['review', 'new', 'new'])
    })

    it('同一个词只会出一张卡：复习与新词重复时不让孩子连着答两遍', () => {
        const queue = buildVocabQueue(
            batch({
                newWords: [{ card: card('w-old', '书', 'book'), direction: 'en2zh' }],
            }),
        )
        expect(queue).toHaveLength(1)
        expect(queue[0]?.kind).toBe('review')
    })

    it('今天没词时队列为空（页面据此给收尾状态，而不是空白卡）', () => {
        expect(buildVocabQueue(batch({ newWords: [], reviews: [] }))).toEqual([])
    })
})

describe('vocabFace', () => {
    it('en2zh 正面是英文单词，zh2en 正面是中文', () => {
        const en2zh = vocabFace({ card: card('w1', '学校', 'school'), direction: 'en2zh', kind: 'new' })
        expect(en2zh.prompt).toBe('school')
        expect(en2zh.script).toBe('latin')

        const zh2en = vocabFace({ card: card('w1', '学校', 'school'), direction: 'zh2en', kind: 'new' })
        expect(zh2en.prompt).toBe('学校')
        expect(zh2en.script).toBe('han')
    })
})

describe('vocabReducer：下一步该显示哪张卡', () => {
    const session = () => createVocabSession(buildVocabQueue(batch()))

    it('答对 → 下一个：换到第二张卡，答对数 +1', () => {
        let s = session()
        expect(currentVocabTask(s)?.card.id).toBe('w-old')

        s = step(s, { type: 'answered', correct: true })
        expect(s.verdict).toBe('correct')

        s = step(s, { type: 'next' })
        expect(currentVocabTask(s)?.card.id).toBe('w-new')
        expect(s.correct).toBe(1)
        expect(s.passed).toBe(1)
        expect(s.verdict).toBeNull()
    })

    it('答错后「再记一次」：停在同一个词，进度不动，也不虚增答对数', () => {
        const s = step(session(), { type: 'answered', correct: false })
        expect(s.verdict).toBe('wrong')

        const retried = step(s, { type: 'retry' })
        expect(currentVocabTask(retried)?.card.id).toBe('w-old')
        expect(retried.index).toBe(0)
        expect(retried.passed).toBe(0)
        expect(retried.correct).toBe(0)
        expect(retried.verdict).toBeNull()

        // 重练答对：只算一次对，也只翻过一张卡
        const corrected = step(retried, { type: 'answered', correct: true })
        expect(corrected.correct).toBe(1)
        const moved = step(corrected, { type: 'next' })
        expect(moved.index).toBe(1)
        expect(moved.passed).toBe(1)
    })

    it('答对之后不能再「再记一次」：否则一次记忆会被算成两次', () => {
        const s = step(session(), { type: 'answered', correct: true })
        expect(step(s, { type: 'retry' })).toEqual(s)
    })

    it('没作答不能「下一个」：跳过一张卡等于少练一张，却没人知道它被跳过了', () => {
        const s = session()
        expect(step(s, { type: 'next' })).toEqual(s)
    })

    it('同一张卡重复交卷不重复计数（网络重发不该让「对」变成两分）', () => {
        let s = step(session(), { type: 'answered', correct: true })
        s = step(s, { type: 'answered', correct: true })
        expect(s.correct).toBe(1)
        expect(s.verdict).toBe('correct')
    })

    it('全部走完 → finished，当前卡为 null（收尾状态而不是空白输入框）', () => {
        let s = session()
        for (let i = 0; i < 3; i += 1) {
            s = step(s, { type: 'answered', correct: true })
            s = step(s, { type: 'next' })
        }
        expect(vocabFinished(s)).toBe(true)
        expect(currentVocabTask(s)).toBeNull()
        expect(s.correct).toBe(3)
        expect(s.passed).toBe(3)
    })

    it('答错但直接点「下一个」：翻过去了，但不算答对', () => {
        let s = step(session(), { type: 'answered', correct: false })
        s = step(s, { type: 'next' })
        expect(s.index).toBe(1)
        expect(s.passed).toBe(1)
        expect(s.correct).toBe(0)
    })
})

describe('masteredRatio', () => {
    it('已学会 / 共多少 → 0..1，共 0 个词时不给 NaN', () => {
        expect(masteredRatio({ total: 40, learning: 3, mastered: 12, dueToday: 1 })).toBeCloseTo(0.3)
        expect(masteredRatio({ total: 0, learning: 0, mastered: 0, dueToday: 0 })).toBe(0)
    })
})

describe('activeQuestionIndex：逐题作答的顺序', () => {
    const questions = [{ id: 'q1', prompt: '' }, { id: 'q2', prompt: '' }, { id: 'q3', prompt: '' }]
    const right = (evidence: string): ReadingAnswer => ({
        status: 'correct',
        reference: 'x',
        evidence,
    })

    it('从第一道开始，答对一道推进一道', () => {
        expect(activeQuestionIndex(questions, {})).toBe(0)
        expect(activeQuestionIndex(questions, { q1: right('a') })).toBe(1)
        expect(activeQuestionIndex(questions, { q1: right('a'), q2: right('b') })).toBe(2)
    })

    it('答错不算做完：那道题仍然是当前题', () => {
        const answers = { q1: { status: 'wrong', hint: '再读一遍' } as ReadingAnswer }
        expect(activeQuestionIndex(questions, answers)).toBe(0)
    })

    it('跳过前面答错的题去答后面的？不会：永远回到第一道没对的题', () => {
        const answers = { q1: { status: 'wrong', hint: 'h' } as ReadingAnswer, q2: right('b') }
        expect(activeQuestionIndex(questions, answers)).toBe(0)
    })

    it('全对 → -1，passageDone 为真', () => {
        const answers = { q1: right('a'), q2: right('b'), q3: right('c') }
        expect(activeQuestionIndex(questions, answers)).toBe(-1)
        expect(passageDone(questions, answers)).toBe(true)
    })

    it('没有题目的短文不算读完（避免空数组被判成 done）', () => {
        expect(passageDone([], {})).toBe(false)
    })
})

describe('markEvidence：把原文依据在短文里标出来', () => {
    const text = 'Lily goes to the supermarket. The apples are expensive, so they buy only three.'

    it('命中的那一句被单独切出来，前后各成一段', () => {
        const parts = markEvidence(text, ['The apples are expensive, so they buy only three.'])
        expect(parts.map((p) => p.hit)).toEqual([false, true])
        expect(parts[1]?.text).toBe('The apples are expensive, so they buy only three.')
        expect(parts.map((p) => p.text).join('')).toBe(text)
    })

    it('大小写不同也能命中（原文里那句常常不在句首）', () => {
        const parts = markEvidence(text, ['lily goes to the supermarket'])
        expect(parts.some((p) => p.hit)).toBe(true)
    })

    it('找不到就整段原样返回：不崩、也不丢文字', () => {
        const parts = markEvidence(text, ['这句话不在原文里'])
        expect(parts).toEqual([{ text, hit: false }])
        expect(markEvidence(text, [''])).toEqual([{ text, hit: false }])
    })

    it('多句依据同时标出来（第二句落在上一句切开的片段里也能找到）', () => {
        const parts = markEvidence(text, [
            'Lily goes to the supermarket.',
            'so they buy only three.',
        ])
        expect(parts.filter((p) => p.hit)).toHaveLength(2)
        expect(parts.map((p) => p.text).join('')).toBe(text)
    })
})

describe('短文列表的说明与完成度', () => {
    const passage = {
        id: 'r-1',
        title: 'At the Supermarket',
        level: 'A1',
        words: 78,
        questionCount: 3,
        answered: 0,
        done: false,
    }

    it('级别 · 词数 · 题数', () => {
        expect(passageMeta(passage)).toBe('A1 · 78 词 · 3 题')
    })

    it('完成度说清读到哪儿，而不是只给一个百分比', () => {
        expect(passageStatus(passage)).toBe('还没读')
        expect(passageStatus({ ...passage, answered: 2 })).toBe('已答 2 / 3 题')
        expect(passageStatus({ ...passage, answered: 3, done: true })).toBe('读完了')
    })
})

describe('explainEnglishFailure：孩子看到的是话，不是状态码', () => {
    it('403 用服务端给的那句话（家长关掉模块）', () => {
        const err = new EnglishApiError('家长把「英语」关掉了。想练单词的话，先跟家长说一声。', 403)
        expect(explainEnglishFailure(err)).toBe(
            '家长把「英语」关掉了。想练单词的话，先跟家长说一声。',
        )
        expect(isModuleBlocked(err)).toBe(true)
    })

    it('接口挂掉 / 断网 → 一句"暂时打不开，稍后再试"，绝不出现 HTTP 编号', () => {
        for (const err of [
            new EnglishApiError('HTTP 500', 500),
            new EnglishApiError(GENERIC_FAILURE, 0),
            new Error('HTTP 502'),
            'boom',
        ]) {
            expect(explainEnglishFailure(err)).toBe(GENERIC_FAILURE)
            expect(explainEnglishFailure(err)).not.toContain('HTTP')
        }
        expect(isModuleBlocked(new EnglishApiError('HTTP 500', 500))).toBe(false)
    })
})
