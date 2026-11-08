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

/**
 * 时间用完时的整页提示（孩子端）。
 *
 * 服务端已经在各个入口返回 429 并给了话；这里把同一句话摆在最上面，
 * 免得孩子一个入口一个入口去撞墙——"前后端都生效"说的就是这件事：
 * 后端拦得住，前端也说得出。
 */
export function UsageExhaustedBanner({ usage, role }: { usage: ActiveUsage; role: string }) {
    if (role === 'parent') return null
    const { budget } = usage
    if (!budget) return null
    if (budget.allowed && budget.remainingMinutes > 0) return null
    return (
        <div className="rounded-[10px] border border-rule bg-paper px-4 py-3 text-sm text-ink-soft">
            今天的时间用完了（每天 {budget.limitMinutes} 分钟）。明天再来，或者去和家长说一声。
        </div>
    )
}
