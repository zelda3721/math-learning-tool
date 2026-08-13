import { describe, expect, it } from 'vitest'
import { splitMath, splitTables } from './MathText'

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

/**
 * 题干里的表格。
 *
 * 统计类讲义的题干里表格是常客，而模型写出来的是 markdown 竖线
 * （偶尔是 LaTeX tabular）。此前两种都原样糊给孩子——
 * 「| 月份 | 1月 | 2月 |」这样一行行源码，孩子读不了。
 */
describe('题干里的表格', () => {
    it('markdown 表格切成行列，分隔行丢掉', () => {
        const input = '根据统计表回答：\n| 月份 | 1月 | 2月 |\n| :--- | :--- | :--- |\n| 产量 | 450 | 300 |\n（1）平均每月多少吨？'
        const blocks = splitTables(input)
        expect(blocks.map((b) => b.kind)).toEqual(['text', 'table', 'text'])
        const table = blocks[1] as { rows: string[][] }
        expect(table.rows).toEqual([
            ['月份', '1月', '2月'],
            ['产量', '450', '300'],
        ])
    })

    it('LaTeX tabular 也解析成行列（实机上模型偶尔这么写）', () => {
        const input =
            '统计如下：\\begin{tabular}{|c|c|}\\hline 种类 & 合计 \\\\\\hline 五年级 & 66 \\\\\\hline\\end{tabular}后续'
        const blocks = splitTables(input)
        const table = blocks.find((b) => b.kind === 'table') as { rows: string[][] }
        expect(table.rows).toEqual([
            ['种类', '合计'],
            ['五年级', '66'],
        ])
    })

    it('待填的空格保留成空单元格', () => {
        const input = '| 星期 | 一 | 二 |\n| 台数 |  | 45 |'
        const table = splitTables(input)[0] as { rows: string[][] }
        expect(table.rows[1]).toEqual(['台数', '', '45'])
    })

    it('单独一行竖线不算表格', () => {
        const blocks = splitTables('绝对值 |x| 的意义')
        expect(blocks.every((b) => b.kind === 'text')).toBe(true)
    })

    it('没有表格的题干原样一块', () => {
        expect(splitTables('一个长方形长 8 厘米')).toEqual([{ kind: 'text', value: '一个长方形长 8 厘米' }])
    })
})
