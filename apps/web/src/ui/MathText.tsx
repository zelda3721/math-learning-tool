/**
 * 数学文本渲染：把 LLM 输出里的 LaTeX（$...$ 行内、$$...$$ 独立、\( \) \[ \]）
 * 渲染为公式，其余部分按纯文本显示（保留换行）。
 * KaTeX 出错时原样显示源码，绝不让孩子看到空白或崩溃。
 */
import { useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

interface Segment {
    kind: 'text' | 'math'
    value: string
    display?: boolean
}

/**
 * 认得的 LaTeX 命令。
 *
 * 用白名单而不是"见到反斜杠就当公式"：题干里偶尔会有别的反斜杠，
 * 一律当公式会让 KaTeX 吐出一片红字，比不渲染更糟。
 * 这份表覆盖小学到初中会用到的：分数、根号、四则、角度、比较、上划线。
 */
const BARE_COMMANDS = [
    'frac', 'dfrac', 'tfrac', 'cfrac', 'sqrt', 'times', 'div', 'cdot', 'pm', 'mp',
    'le', 'leq', 'ge', 'geq', 'ne', 'neq', 'approx', 'angle', 'circ', 'degree',
    'overline', 'underline', 'bar', 'vec', 'triangle', 'square', 'perp', 'parallel',
    'cong', 'sim', 'ldots', 'cdots', 'dots', 'infty', 'sum', 'prod', 'int', 'lim',
    'alpha', 'beta', 'gamma', 'theta', 'pi', 'text', 'mathrm', 'left', 'right',
]

/**
 * 找出**没有 $ 包裹**的 LaTeX 片段。
 *
 * 抽取模型时常直接写 `50\frac{1}{4}` 而不加定界符——实机上就有一道
 * 「将50.032，50\frac{1}{4}，49.99，50.00按从小到大排列」，
 * 界面上原样显示成了 `50\frac{1}{4}`。与其指望模型每次都记得加 $，
 * 不如让渲染器认得。
 *
 * 片段的边界：命令名 + 紧随其后的 {...} 参数，再向两侧吃掉相邻的数字
 * （`50\frac{1}{4}` 是带分数，`2\times3` 是一个算式，拆开都读不通）。
 */
function bareMathRuns(text: string): { start: number; end: number }[] {
    const runs: { start: number; end: number }[] = []
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] !== '\\') continue
        const name = /^[a-zA-Z]+/.exec(text.slice(i + 1))?.[0]
        if (!name || !BARE_COMMANDS.includes(name)) continue

        let end = i + 1 + name.length
        // 吃掉紧随的 {...} 参数（\frac 有两个）
        while (text[end] === '{') {
            let depth = 0
            let j = end
            for (; j < text.length; j += 1) {
                if (text[j] === '{') depth += 1
                else if (text[j] === '}') {
                    depth -= 1
                    if (depth === 0) break
                }
            }
            if (depth !== 0) break // 括号没闭合：到此为止，别把后面整段吞进去
            end = j + 1
        }
        // 右边相邻的数字属于同一个算式（2\times3）
        while (end < text.length && /[\d.]/.test(text[end]!)) end += 1
        // 左边相邻的数字也是（50\frac{1}{4} 是一个带分数）
        let start = i
        const floor = runs.length ? runs[runs.length - 1]!.end : 0
        while (start > floor && /[\d.]/.test(text[start - 1]!)) start -= 1

        const prev = runs[runs.length - 1]
        if (prev && prev.end === start) prev.end = end // 1\times2\times3 是一整个算式
        else runs.push({ start, end })
        i = end - 1
    }
    return runs
}

/** 把一段纯文本里裸露的 LaTeX 挑出来 */
function splitBare(value: string): Segment[] {
    const runs = bareMathRuns(value)
    if (runs.length === 0) return [{ kind: 'text', value }]
    const out: Segment[] = []
    let last = 0
    for (const run of runs) {
        if (run.start > last) out.push({ kind: 'text', value: value.slice(last, run.start) })
        out.push({ kind: 'math', value: value.slice(run.start, run.end), display: false })
        last = run.end
    }
    if (last < value.length) out.push({ kind: 'text', value: value.slice(last) })
    return out
}

/** 切分出 $$...$$ / $...$ / \[...\] / \(...\) 片段（$ 前有反斜杠时视为普通美元符） */
export function splitMath(input: string): Segment[] {
    const segments: Segment[] = []
    const pattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(?<!\\)\$([^$\n]+?)(?<!\\)\$|\\\(([\s\S]+?)\\\)/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(input)) !== null) {
        if (m.index > last) segments.push(...splitBare(input.slice(last, m.index)))
        const display = m[1] !== undefined || m[2] !== undefined
        const body = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
        segments.push({ kind: 'math', value: body.trim(), display })
        last = m.index + m[0].length
    }
    if (last < input.length) segments.push(...splitBare(input.slice(last)))
    return segments
}

function renderMath(value: string, display: boolean): string | null {
    try {
        return katex.renderToString(value, {
            displayMode: display,
            throwOnError: false,
            strict: false,
            output: 'html',
        })
    } catch {
        return null
    }
}

export function MathText({ children, className = '' }: { children: string; className?: string }) {
    const segments = useMemo(() => splitMath(children ?? ''), [children])
    return (
        <span className={`whitespace-pre-wrap ${className}`}>
            {segments.map((seg, i) => {
                if (seg.kind === 'text') return <span key={i}>{seg.value}</span>
                const html = renderMath(seg.value, seg.display ?? false)
                if (html === null) return <span key={i}>{seg.display ? `$$${seg.value}$$` : `$${seg.value}$`}</span>
                return (
                    <span
                        key={i}
                        className={seg.display ? 'block my-2 text-center' : ''}
                        // KaTeX 输出的是它自己生成的 HTML（非用户 HTML），渲染前已经过 KaTeX 转义
                        dangerouslySetInnerHTML={{ __html: html }}
                    />
                )
            })}
        </span>
    )
}
