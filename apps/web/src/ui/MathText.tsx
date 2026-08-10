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

/** 切分出 $$...$$ / $...$ / \[...\] / \(...\) 片段（$ 前有反斜杠时视为普通美元符） */
export function splitMath(input: string): Segment[] {
    const segments: Segment[] = []
    const pattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(?<!\\)\$([^$\n]+?)(?<!\\)\$|\\\(([\s\S]+?)\\\)/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(input)) !== null) {
        if (m.index > last) segments.push({ kind: 'text', value: input.slice(last, m.index) })
        const display = m[1] !== undefined || m[2] !== undefined
        const body = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
        segments.push({ kind: 'math', value: body.trim(), display })
        last = m.index + m[0].length
    }
    if (last < input.length) segments.push({ kind: 'text', value: input.slice(last) })
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
