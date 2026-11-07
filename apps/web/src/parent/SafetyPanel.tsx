import { useCallback, useEffect, useState } from 'react'

import { Badge, Button, Card } from '../ui'
import { ApiError, fetchLimits, fetchSafety, postLimits, type ChatLimits, type SafetyReport } from './api'

/**
 * 家长中心里的「对话安全 + 时长」面板。
 *
 * 两件事必须让家长**看得见并且改得动**：
 * 1. 孩子被拦下过什么。这里只显示「什么时候 / 哪一类 / 拦还是转移」——
 *    不显示原话。家长需要的是知情和判断，不是把孩子的每句试探都存档。
 * 2. 每天能聊多久。上限由家长定，没定就按学段默认；页面要写清当前是哪一种，
 *    否则"我明明没设，怎么只有 20 分钟"会变成一次莫名其妙的争执。
 */

const REASON_LABEL: Record<string, string> = {
    'unsafe-content': '不适宜内容',
    privacy: '个人信息',
    'contact-request': '要联系方式/约见面',
    'answer-seeking': '直接要答案',
    'off-topic': '与学习无关',
    'time-budget': '时长用完',
    unknown: '其他',
}

const fieldCls =
    'w-24 px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px] focus:outline-none focus:border-beam focus:ring-2 focus:ring-beam-wash'

export function SafetyPanel({ learnerId }: { learnerId: string }) {
    const [report, setReport] = useState<SafetyReport | null>(null)
    const [limits, setLimits] = useState<ChatLimits | null>(null)
    const [draft, setDraft] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback(async () => {
        setError(null)
        try {
            const [nextReport, nextLimits] = await Promise.all([fetchSafety(learnerId), fetchLimits(learnerId)])
            setReport(nextReport)
            setLimits(nextLimits)
            setDraft(String(nextLimits.limitMinutes))
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        void load()
    }, [load])

    const save = async (minutes: number | null) => {
        setBusy(true)
        setError(null)
        try {
            const next = await postLimits({ learnerId, dailyChatMinutes: minutes })
            setLimits(next)
            setDraft(String(next.limitMinutes))
            setNotice(minutes === null ? '已恢复按学段默认时长' : `已设为每天 ${minutes} 分钟`)
        } catch (err) {
            setError(err instanceof ApiError ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <Card className="p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">对话安全与时长</h3>
                {limits && (
                    <Badge tone={limits.allowed ? 'emerald' : 'amber'}>
                        今天 {limits.usedMinutes} / {limits.limitMinutes} 分钟
                    </Badge>
                )}
            </div>

            {error && <div className="text-sm text-[color:var(--color-wrong)]">{error}</div>}
            {notice && <div className="text-sm text-[color:var(--color-correct)]">{notice}</div>}

            {limits && (
                <div className="space-y-2">
                    <div className="text-sm text-ink-soft">
                        每天可对话 {limits.limitMinutes} 分钟
                        {limits.source === 'default' ? '（按学段默认）' : '（你设置的）'}
                        ，今天还剩 {limits.remainingMinutes} 分钟
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <input
                            className={fieldCls}
                            value={draft}
                            inputMode="numeric"
                            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
                            aria-label="每天对话分钟数"
                        />
                        <Button size="sm" disabled={busy || draft === ''} onClick={() => void save(Number(draft))}>
                            保存
                        </Button>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void save(null)}>
                            恢复默认
                        </Button>
                    </div>
                </div>
            )}

            <div className="space-y-2">
                <div className="text-sm text-ink-soft">
                    最近被拦下的对话（只记类别与时间，不记孩子原话）
                </div>
                {!report || report.total === 0 ? (
                    <div className="text-sm text-ink-faint">还没有被拦下的记录。</div>
                ) : (
                    <ul className="space-y-1">
                        {report.events.slice(0, 8).map((event, i) => (
                            <li key={`${event.at}-${i}`} className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                                <span className="numeric text-ink-faint">
                                    {new Date(event.at).toLocaleString('zh-CN', { hour12: false })}
                                </span>
                                <span>{REASON_LABEL[event.reason] ?? event.reason}</span>
                                <Badge tone={event.action === '拦下' ? 'red' : 'amber'}>{event.action}</Badge>
                                <span className="text-xs text-ink-faint">{event.where}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Card>
    )
}
