/**
 * 「孩子账号」管理面板（仅家长可见）：
 * - GET /api/v1/auth/children：列表（用户名 / 年级 / 注册时间）+「名额 n/5」徽章；
 * - POST /api/v1/auth/children/:id/reset-password：prompt 输入新密码（≥4 位）；
 * - DELETE /api/v1/auth/children/:id：confirm 后删除账号（学习数据保留，名额释放）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Badge, Button, ErrorState, LoadingState } from '../ui'

const LEVEL_LABELS: Record<string, string> = {
    elementary_lower: '小学低年级',
    elementary_upper: '小学高年级',
    middle: '初中',
    high: '高中',
    advanced: '进阶',
}

interface ChildAccount {
    id: string
    username: string
    createdAt: string
    learnerId?: string
    learner?: { id: string; name: string; level: string } | null
}

interface ChildrenResponse {
    children: ChildAccount[]
    childLimit: number
}

type PanelState =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; children: ChildAccount[]; childLimit: number }

async function readError(res: Response, fallback: string): Promise<string> {
    try {
        const body = (await res.json()) as { error?: string }
        return body.error || fallback
    } catch {
        return fallback
    }
}

function formatDate(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function ChildrenPanel() {
    const { user, refresh } = useAuth()
    const [state, setState] = useState<PanelState>({ kind: 'loading' })
    const [busyId, setBusyId] = useState<string | null>(null)
    const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

    const isParent = user?.role === 'parent'

    const load = useCallback(async () => {
        setState({ kind: 'loading' })
        try {
            const res = await fetch('/api/v1/auth/children')
            if (!res.ok) throw new Error(await readError(res, `HTTP ${res.status}`))
            const body = (await res.json()) as ChildrenResponse
            setState({ kind: 'ready', children: body.children ?? [], childLimit: body.childLimit ?? 5 })
        } catch (err) {
            setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        }
    }, [])

    useEffect(() => {
        if (isParent) void load()
    }, [isParent, load])

    if (!isParent) return null

    const resetPassword = async (child: ChildAccount) => {
        if (busyId) return
        const input = window.prompt(`为「${child.username}」设置新密码（至少 4 位）`)
        if (input === null) return
        const password = input.trim()
        if (password.length < 4) {
            setNotice({ ok: false, text: '密码至少 4 位，本次未重置。' })
            return
        }
        setBusyId(child.id)
        setNotice(null)
        try {
            const res = await fetch(
                `/api/v1/auth/children/${encodeURIComponent(child.id)}/reset-password`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ password }),
                }
            )
            if (!res.ok) throw new Error(await readError(res, '重置密码失败'))
            setNotice({ ok: true, text: `已为「${child.username}」重置密码。` })
        } catch (err) {
            setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
        } finally {
            setBusyId(null)
        }
    }

    /**
     * 清空学习记录，回到初始状态。
     *
     * 场景：题库推倒重建（删掉 demo 题、换成真材料）之后，掌握度、复习卡、
     * 错题全指着不存在的旧题——星图亮着不该亮的星，复习队列在等一道已删除的题。
     * 账号与登录不动，只清学习痕迹。危险操作，要求把孩子的名字原样再输一遍。
     */
    const resetLearning = async (child: ChildAccount) => {
        if (busyId || !child.learner) return
        const typed = window.prompt(
            `把「${child.learner.name}」的学习记录清回初始状态？\n` +
                '做题记录、掌握度、复习计划、错题本会全部清空（账号和密码不动）。\n' +
                `确认请输入孩子的名字：`,
        )
        if (typed === null) return
        setBusyId(child.id)
        setNotice(null)
        try {
            const res = await fetch('/api/v1/parent/reset-learner', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ learnerId: child.learner.id, confirm: typed.trim() }),
            })
            if (!res.ok) throw new Error(await readError(res, '重置失败'))
            const body = (await res.json()) as { cleared: { table: string; removed: number }[] }
            const total = body.cleared.reduce((n, c) => n + c.removed, 0)
            setNotice({ ok: true, text: `已清空「${child.learner.name}」的 ${total} 条学习记录，从头开始。` })
        } catch (err) {
            setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
        } finally {
            setBusyId(null)
        }
    }

    const removeChild = async (child: ChildAccount) => {
        if (busyId) return
        const confirmed = window.confirm(
            `确定删除「${child.username}」的账号吗？\n删除后该账号无法登录；学习数据会保留，名额随之释放。`
        )
        if (!confirmed) return
        setBusyId(child.id)
        setNotice(null)
        try {
            const res = await fetch(`/api/v1/auth/children/${encodeURIComponent(child.id)}`, {
                method: 'DELETE',
            })
            if (!res.ok) throw new Error(await readError(res, '删除账号失败'))
            setNotice({ ok: true, text: `已删除「${child.username}」的账号，学习数据已保留。` })
            await load()
            // 同步全局 bootstrap（childCount / 名额），失败不影响本面板
            void refresh().catch(() => undefined)
        } catch (err) {
            setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
        } finally {
            setBusyId(null)
        }
    }

    return (
        <section className="plate p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
                <h3 className="text-section">孩子账号</h3>
                {state.kind === 'ready' && (
                    <Badge tone={state.children.length >= state.childLimit ? 'wrong' : 'beam'}>
                        名额 <span className="numeric">{state.children.length}/{state.childLimit}</span>
                    </Badge>
                )}
            </div>

            {state.kind === 'loading' && <LoadingState text="正在加载孩子账号……" />}

            {state.kind === 'error' && (
                <ErrorState message={state.message} onRetry={() => void load()} />
            )}

            {state.kind === 'ready' && state.children.length === 0 && (
                <p className="text-sm text-ink-faint">
                    还没有孩子账号——在登录页用「注册孩子账号」创建。
                </p>
            )}

            {state.kind === 'ready' && state.children.length > 0 && (
                <ul className="space-y-3">
                    {state.children.map((child) => (
                        <li
                            key={child.id}
                            className="rounded-[10px] border border-rule bg-paper p-4 flex flex-wrap items-center justify-between gap-3"
                        >
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="font-semibold text-ink truncate">
                                        {child.username}
                                    </span>
                                    {child.learner?.level && (
                                        <Badge tone="slate">
                                            {LEVEL_LABELS[child.learner.level] ?? child.learner.level}
                                        </Badge>
                                    )}
                                </div>
                                <p className="text-xs text-ink-faint mt-1">
                                    注册于 <span className="numeric">{formatDate(child.createdAt)}</span>
                                </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busyId !== null}
                                    onClick={() => void resetPassword(child)}
                                >
                                    重置密码
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busyId === child.id || !child.learner}
                                    onClick={() => void resetLearning(child)}
                                >
                                    清空学习记录
                                </Button>
                                <Button
                                    size="sm"
                                    variant="danger"
                                    disabled={busyId !== null}
                                    onClick={() => void removeChild(child)}
                                >
                                    删除账号
                                </Button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {notice && (
                <p
                    className={`text-sm ${
                        notice.ok ? 'text-[color:var(--color-correct)]' : 'text-wrong'
                    }`}
                >
                    {notice.text}
                </p>
            )}
        </section>
    )
}
