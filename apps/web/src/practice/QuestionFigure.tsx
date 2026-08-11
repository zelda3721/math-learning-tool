/**
 * 题目配图。
 *
 * 图不是存下来的位图，而是由「点线角 + 约束」当场解算出来的——
 * 解完还要逐条回代验证，图上量出来的边长角度必须与题干声明一致。
 * 验不过就不画，退回纯文字：一张边长与题干对不上的图，比没有图坏得多
 * （孩子会照着图数，得到的结论是错的）。
 */
import { useMemo } from 'react'
import { renderFigure, type FigureSpec } from '@mathtutor/explainer-web'

export function QuestionFigure({ figure, width = 300 }: { figure: FigureSpec; width?: number }) {
    const drawn = useMemo(() => {
        try {
            return renderFigure(figure, { width })
        } catch {
            return null
        }
    }, [figure, width])

    if (!drawn) {
        // 说清楚是"这张图没画出来"，而不是让人以为题目就长这样
        return (
            <p className="text-xs text-ink-faint border border-rule rounded-[10px] px-3 py-2">
                这道题的配图没能按题干的条件画出来，先按文字理解；已记录待家长核对。
            </p>
        )
    }
    return (
        <div className="flex justify-center py-1">
            <div
                className="max-w-full overflow-x-auto"
                // 图由本机解算生成，不含外部内容；标签在渲染时已转义
                dangerouslySetInnerHTML={{ __html: drawn.svg }}
            />
        </div>
    )
}
