import { describe, expect, it } from 'vitest'
import { splitMath } from './MathText'

describe('splitMath', () => {
    it('splits inline $...$ keeping surrounding text', () => {
        const segs = splitMath('因为 $1 \\times 0 = 0$ 所以不行')
        expect(segs.map((s) => s.kind)).toEqual(['text', 'math', 'text'])
        expect(segs[1]!.value).toBe('1 \\times 0 = 0')
        expect(segs[1]!.display).toBe(false)
    })

    it('handles display $$...$$ and \\[...\\]', () => {
        expect(splitMath('$$a^2+b^2$$')[0]).toMatchObject({ kind: 'math', display: true })
        expect(splitMath('\\[x=1\\]')[0]).toMatchObject({ kind: 'math', display: true })
    })

    it('handles \\(...\\) inline form', () => {
        const segs = splitMath('答案是 \\(x=4\\)。')
        expect(segs[1]).toMatchObject({ kind: 'math', value: 'x=4', display: false })
    })

    it('leaves plain text and escaped dollars alone', () => {
        expect(splitMath('一共 5 元钱').every((s) => s.kind === 'text')).toBe(true)
        expect(splitMath('价格 \\$5 起').every((s) => s.kind === 'text')).toBe(true)
    })

    it('does not treat multi-line text between dollars as math', () => {
        const segs = splitMath('第一行 $ 换行\n第二行 $ 结束')
        expect(segs.every((s) => s.kind === 'text')).toBe(true)
    })
})
