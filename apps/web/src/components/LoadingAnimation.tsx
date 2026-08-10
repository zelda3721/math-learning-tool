/**
 * LoadingAnimation — 克制的不定态进度：一段脉动的 beam 细线。
 * 金色 lightline 只表示"学会了"，所以这里用交互色，不用金色。
 */
export function LoadingAnimation({ text }: { text?: string } = {}) {
    return (
        <div className="flex flex-col items-center gap-3 py-10">
            <span className="eyebrow">正在思考</span>
            <div className="w-44 h-[3px] rounded-full bg-rule overflow-hidden">
                <span className="block h-full w-1/3 rounded-full bg-beam animate-pulse" />
            </div>
            <p className="text-sm text-ink-faint">{text ?? '正在拆解题目并准备讲解'}</p>
        </div>
    )
}
