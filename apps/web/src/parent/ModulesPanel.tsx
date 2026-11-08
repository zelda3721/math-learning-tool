import { useCallback, useEffect, useState } from 'react'

import { Badge, Button, Card } from '../ui'
import { fetchModules, postModules, type ModuleState } from './api'

/**
 * 家长中心里的「模块开关」面板。
 *
 * 开关落在服务端（一眼可见写清）：关掉之后对应入口直接 403，
 * 不是"界面上藏起来"——藏起来只是没给门，换个客户端照样进得去。
 *
 * 默认全开：家长没表态之前不该少东西。孩子那边看到的是服务端给的那句话
 * （「家长把『课堂』关掉了……」），不是一串状态码。
 */

export function ModulesPanel({ learnerId }: { learnerId: string }) {
    const [state, setState] = useState<ModuleState | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [busy, setBusy] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            setState(await fetchModules(learnerId))
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        setState(null)
        setNotice(null)
        void load()
    }, [load])

    const toggle = async (id: string, enabled: boolean) => {
        setBusy(id)
        setError(null)
        try {
            const next = await postModules({ learnerId, modules: { [id]: enabled } })
            setState(next)
            setNotice(next.modules[id] === false ? '已关闭，孩子那边立刻打不开了' : '已打开')
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(null)
        }
    }

    return (
        <Card className="p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">模块开关</h3>
                <Badge tone="slate">默认全开</Badge>
            </div>

            <p className="text-sm text-ink-soft leading-relaxed">
                关掉之后，孩子打开那一块会看到一句话说明是家长关的；服务端同时把入口挡住，
                不是只在界面上藏起来。
            </p>

            {error && <div className="text-sm text-[color:var(--color-wrong)]">{error}</div>}
            {notice && <div className="text-sm text-[color:var(--color-correct)]">{notice}</div>}

            {!state ? (
                <div className="text-sm text-ink-faint">正在加载……</div>
            ) : (
                <ul className="space-y-3">
                    {state.catalog.map((module) => {
                        const enabled = state.modules[module.id] !== false
                        return (
                            <li
                                key={module.id}
                                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-rule bg-paper px-4 py-3"
                            >
                                <div className="min-w-40">
                                    <div className="text-sm font-semibold text-ink flex items-center gap-2">
                                        {module.label}
                                        <Badge tone={enabled ? 'emerald' : 'slate'}>{enabled ? '开' : '关'}</Badge>
                                    </div>
                                    <div className="text-xs text-ink-faint mt-0.5">{module.hint}</div>
                                </div>
                                <Button
                                    size="sm"
                                    variant={enabled ? 'secondary' : 'primary'}
                                    disabled={busy === module.id}
                                    onClick={() => void toggle(module.id, !enabled)}
                                >
                                    {enabled ? '关掉' : '打开'}
                                </Button>
                            </li>
                        )
                    })}
                </ul>
            )}
        </Card>
    )
}
