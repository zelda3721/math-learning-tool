import type { ActiveUsage } from './useActiveUsage'

/**
 * 今天还剩多少时间：顶栏的一颗小标 + 一条休息提醒。
 *
 * 只给孩子看。家长看的是家长页里的报表（"今天用了多久、上限是谁定的"）。
 * 用完时不给红色警告条——那会让孩子觉得被系统审判了；说清"明天再来"就够了。
 */
export function UsageBadge({ usage, role }: { usage: ActiveUsage; role: string }) {
    if (role === 'parent') return null
    const { budget, breakDue, breakAfterMinutes, dismissBreak } = usage
    if (!budget) return null

    const left = budget.remainingMinutes
    const exhausted = !budget.allowed || left <= 0
    return (
        <div className="flex items-center gap-2">
            {breakDue && (
                <div className="hidden md:flex items-center gap-2 rounded-[10px] bg-[#fff7e6] px-2.5 py-1 text-xs text-[#8a5a00]">
                    <span>已经连着学了 {breakAfterMinutes} 分钟，起来动一动眼睛和肩膀吧</span>
                    <button
                        type="button"
                        onClick={dismissBreak}
                        className="font-semibold underline decoration-dotted underline-offset-2"
                    >
                        知道了
                    </button>
                </div>
            )}
            <span
                className={`hidden sm:inline-flex items-center rounded-[10px] px-2.5 py-1 text-xs font-semibold numeric ${
                    exhausted ? 'bg-wrong-wash text-wrong' : left <= 5 ? 'bg-[#fff7e6] text-[#8a5a00]' : 'bg-paper text-ink-soft'
                }`}
                title={`上限 ${budget.limitMinutes} 分钟（${budget.source === 'parent' ? '家长设定' : '按学段默认'}）`}
            >
                {exhausted ? '今天的时间用完了' : `今天还剩 ${left} 分钟`}
            </span>
        </div>
    )
}
