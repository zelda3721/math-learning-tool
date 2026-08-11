/**
 * 题目原图：讲义上那一块，原样显示。
 *
 * 这是配图的主表示，不是 QuestionFigure 的备胎。原因很实在：
 * 它就是原图，不存在重新理解的风险；而由模型转写的「点线角 + 约束」
 * 再工整也是二手的——实机上见过它把直角梯形画成上下颠倒。
 *
 * QuestionFigure（解算出来的矢量图）仍有不可替代的用处：讲解时要高亮某条边、
 * 要割补、变式改数字时图要跟着变——这些位图都做不到。但那是按需转写的增强。
 */
export function QuestionImage({ name, alt = '题目配图' }: { name: string; alt?: string }) {
    return (
        <div className="flex justify-center py-1">
            <img
                src={`/api/v1/figures/${encodeURIComponent(name)}`}
                alt={alt}
                loading="lazy"
                className="max-w-full max-h-80 rounded-[6px]"
            />
        </div>
    )
}
