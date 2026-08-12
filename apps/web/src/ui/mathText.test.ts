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

/**
 * 没有 $ 包裹的 LaTeX。
 *
 * 抽取模型时常直接写 `50\frac{1}{4}`——实机上就有一道
 * 「将50.032，50\frac{1}{4}，49.99，50.00按从小到大排列」，
 * 界面上原样显示成了源码。与其指望模型每次记得加 $，不如让渲染器认得。
 */
describe('裸露的 LaTeX', () => {
    const math = (s: string) => splitMath(s).filter((x) => x.kind === 'math').map((x) => x.value)

    it('带分数：左边相邻的数字属于同一个式子', () => {
        const input = '将50.032，50\\frac{1}{4}，49.99，50.00按照从小到大的顺序排列：'
        expect(math(input)).toEqual(['50\\frac{1}{4}'])
        // 其余部分原样保留，一个字都不能少
        expect(splitMath(input).map((s) => s.value).join('')).toBe(input)
    })

    it('算式：右边相邻的数字也算进去', () => {
        expect(math('每份2\\times3个')).toEqual(['2\\times3'])
    })

    it('连着几个运算符是一整个式子，不拆开', () => {
        expect(math('1\\times2\\times3')).toEqual(['1\\times2\\times3'])
    })

    it('已经有 $ 的照旧，不重复处理', () => {
        expect(math('先写下$\\frac{10}{3}$，再写50\\frac{1}{4}')).toEqual([
            '\\frac{10}{3}',
            '50\\frac{1}{4}',
        ])
    })

    it('不认识的反斜杠不动它——当公式会让 KaTeX 吐一片红字', () => {
        expect(math('路径 C:\\Users\\abc')).toEqual([])
        expect(splitMath('路径 C:\\Users\\abc')[0]!.value).toBe('路径 C:\\Users\\abc')
    })

    it('括号没闭合时不把后面整段吞进去', () => {
        const input = '这里\\frac{1{2 后面还有很多字'
        expect(splitMath(input).map((s) => s.value).join('')).toBe(input)
    })

    it('根号与角度', () => {
        // 片段止于命令的参数：= 不是数字，所以 =4 留在文本里。
        // 够用了——渲染出来是「√16 = 4」，只是等号没进公式字体
        expect(math('\\sqrt{16}=4')).toEqual(['\\sqrt{16}'])
        expect(math('∠1=45\\circ')).toEqual(['45\\circ'])
    })
})
