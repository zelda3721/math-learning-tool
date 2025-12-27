export function LoadingAnimation() {
    return (
        <div className="glass p-8 flex flex-col items-center justify-center gap-6">
            {/* Animated Math Symbols */}
            <div className="flex gap-4 text-4xl">
                {['➕', '➖', '✖️', '➗', '🔢'].map((symbol, i) => (
                    <span
                        key={i}
                        className="animate-bounce"
                        style={{ animationDelay: `${i * 0.1}s` }}
                    >
                        {symbol}
                    </span>
                ))}
            </div>

            {/* Loading Text */}
            <div className="text-center">
                <h3 className="text-lg font-semibold gradient-text mb-2">
                    AI 正在思考中...
                </h3>
                <p className="text-sm text-zinc-500">
                    分析题目 → 生成解法 → 创建可视化
                </p>
            </div>

            {/* Progress Bar */}
            <div className="w-full max-w-xs h-1 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-purple-500 to-pink-500 rounded-full animate-shimmer" />
            </div>
        </div>
    )
}
