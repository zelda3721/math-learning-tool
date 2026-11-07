import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 使用时长：孩子这边的计时与提醒。
 *
 * 为什么计时放在前端：时长上限管的是"孩子用了多久"，只有页面知道
 * 标签页是不是可见、人是不是还在。服务端按真实流逝封顶（见 routes/usage.ts），
 * 所以前端多报也没用；前端只负责如实上报。
 *
 * 三条约束：
 * 1. **只在标签页可见时计时**。切走、最小化、锁屏都不算——这是孩子真正"在用"的时间。
 * 2. 每 30 秒上报一次，页面隐藏和卸载时再补报一次（用 keepalive，别丢最后一段）。
 * 3. 连续用太久给一句休息提醒，不弹窗、不打断当前这一拍。
 */

interface Budget {
    allowed: boolean
    usedMinutes: number
    limitMinutes: number
    remainingMinutes: number
    source: 'parent' | 'default'
}

interface ActiveReply {
    budget: Budget
    breakDue: boolean
    breakAfterMinutes: number
    clamped: boolean
}

const FLUSH_MS = 30_000

export interface ActiveUsage {
    budget: Budget | null
    breakDue: boolean
    breakAfterMinutes: number
    /** 孩子点掉提醒后本轮的连续计时归零 */
    dismissBreak: () => void
    reload: () => void
}

export function useActiveUsage(learnerId: string | undefined): ActiveUsage {
    const [budget, setBudget] = useState<Budget | null>(null)
    const [breakDue, setBreakDue] = useState(false)
    const [breakAfterMinutes, setBreakAfterMinutes] = useState(40)

    const pendingRef = useRef(0)
    const continuousRef = useRef(0)
    const lastTickRef = useRef<number | null>(null)

    const reload = useCallback(() => {
        if (!learnerId) return
        void fetch(`/api/v1/usage/today?learnerId=${encodeURIComponent(learnerId)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((b: (Budget & { breakAfterMinutes?: number }) | null) => {
                if (!b) return
                setBudget(b)
                if (typeof b.breakAfterMinutes === 'number') setBreakAfterMinutes(b.breakAfterMinutes)
            })
            .catch(() => {
                /* 计时是辅助信息，后端不可用时不该打断学习 */
            })
    }, [learnerId])

    const flush = useCallback(
        (keepalive = false) => {
            if (!learnerId) return
            const seconds = Math.round(pendingRef.current)
            pendingRef.current -= seconds
            if (seconds < 1) return
            void fetch('/api/v1/usage/active', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    learnerId,
                    seconds,
                    continuousMinutes: Math.round(continuousRef.current / 60),
                }),
                keepalive,
            })
                .then((r) => (r.ok ? r.json() : null))
                .then((b: ActiveReply | null) => {
                    if (!b) return
                    setBudget(b.budget)
                    setBreakAfterMinutes(b.breakAfterMinutes)
                    if (b.breakDue) setBreakDue(true)
                })
                .catch(() => {
                    // 上报失败就把这段时长还回去，下一次重试，不静默丢掉
                    pendingRef.current += seconds
                })
        },
        [learnerId],
    )

    useEffect(() => {
        if (!learnerId) return
        reload()

        const tick = () => {
            const now = Date.now()
            const last = lastTickRef.current
            lastTickRef.current = now
            // 可见才算：切走的那段时间不算孩子在用
            if (document.visibilityState !== 'visible') return
            const delta = last === null ? 0 : Math.min((now - last) / 1000, 5)
            pendingRef.current += Math.max(0, delta)
            continuousRef.current += Math.max(0, delta)
        }
        const timer = window.setInterval(tick, 1000)
        const reporter = window.setInterval(() => flush(), FLUSH_MS)

        const onHidden = () => {
            if (document.visibilityState === 'hidden') {
                lastTickRef.current = null
                flush(true)
            } else {
                lastTickRef.current = Date.now()
            }
        }
        document.addEventListener('visibilitychange', onHidden)
        return () => {
            window.clearInterval(timer)
            window.clearInterval(reporter)
            document.removeEventListener('visibilitychange', onHidden)
            flush(true)
        }
    }, [learnerId, reload, flush])

    const dismissBreak = useCallback(() => {
        continuousRef.current = 0
        setBreakDue(false)
    }, [])

    return { budget, breakDue, breakAfterMinutes, dismissBreak, reload }
}
