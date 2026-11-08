import { useCallback, useEffect, useState } from 'react'

import { Badge, Button, Card } from '../ui'
import {
    deleteTranscripts,
    fetchTranscripts,
    postTranscriptRecording,
    type TranscriptReport,
    type TranscriptTurn,
} from './api'

/**
 * 家长中心里的「对话转写」面板。
 *
 * 三件事必须写在页面上，而不是写在代码注释里：
 * 1. **默认不记录**。孩子说那些话时并不知道有人在听，默认录音等于替他决定。
 * 2. 开启后**只存在这台机器的本地数据库**，不上传任何地方。
 * 3. 关掉再打开**不回溯**：关掉期间说的话就是没记，别指望翻得回来。
 *
 * 被安全层拦下的那一轮只显示「拦下了 + 原因」——原话连本地库都不留
 * （与安全面板同一套纪律：日志不该成为第二个泄露面）。
 */

const REASON_LABEL: Record<string, string> = {
    'unsafe-content': '不适宜内容',
    privacy: '个人信息',
    'contact-request': '要联系方式/约见面',
    'answer-seeking': '直接要答案',
    'off-topic': '与学习无关',
    unknown: '其他',
}

/** `input:privacy` → 「孩子输入 · 个人信息」 */
function describeBlocked(reason: string | null): string {
    if (!reason) return '被拦下'
    const [where, ...rest] = reason.split(':')
    const whereLabel = where === 'output' ? '模型输出' : '孩子输入'
    const code = rest.join(':') || 'unknown'
    return `${whereLabel} · ${REASON_LABEL[code] ?? code}`
}

function TurnRow({ turn }: { turn: TranscriptTurn }) {
    if (turn.role === 'blocked') {
        return (
            <li className="text-sm text-ink-soft">
                <span className="numeric text-xs text-ink-faint">
                    {new Date(turn.ts).toLocaleString('zh-CN', { hour12: false })}
                </span>
                <span className="ml-2">
                    <Badge tone="red">被拦下</Badge>{' '}
                    <span className="text-ink-faint">{describeBlocked(turn.safetyReason)}（原话不留存）</span>
                </span>
            </li>
        )
    }
    const isChild = turn.role === 'user'
    return (
        <li className="text-sm">
            <span className="numeric text-xs text-ink-faint">
                {new Date(turn.ts).toLocaleString('zh-CN', { hour12: false })}
            </span>
            <span className={`ml-2 font-semibold ${isChild ? 'text-ink' : 'text-ink-soft'}`}>
                {isChild ? '孩子：' : '导师：'}
            </span>
            <span className="text-ink-soft whitespace-pre-wrap">{turn.content}</span>
        </li>
    )
}

export function TranscriptPanel({ learnerId }: { learnerId: string }) {
    const [report, setReport] = useState<TranscriptReport | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const load = useCallback(async () => {
        setError(null)
        try {
            setReport(await fetchTranscripts(learnerId))
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        setReport(null)
        setNotice(null)
        void load()
    }, [load])

    const toggle = async (enabled: boolean) => {
        setBusy(true)
        setError(null)
        try {
            await postTranscriptRecording({ learnerId, enabled })
            setNotice(enabled ? '已开始记录，只存在这台机器上' : '已停止记录（之前记下的还在，可以清空）')
            await load()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const clear = async () => {
        setBusy(true)
        setError(null)
        try {
            const { removed } = await deleteTranscripts(learnerId)
            setNotice(`已清空 ${removed} 条记录`)
            await load()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    const recording = report?.recording ?? false

    return (
        <Card className="p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">对话转写</h3>
                <Badge tone={recording ? 'emerald' : 'slate'}>{recording ? '正在记录' : '默认不记录'}</Badge>
            </div>

            <p className="text-sm text-ink-soft leading-relaxed">
                默认不记录：孩子在探索里说的话，本来就当作没人在旁边听。
                打开后，通过安全检查的对话会存进这台机器的本地数据库，只有你能看到，可以随时清空。
                关掉再打开不会补记关掉期间说过的话。
            </p>

            {error && <div className="text-sm text-[color:var(--color-wrong)]">{error}</div>}
            {notice && <div className="text-sm text-[color:var(--color-correct)]">{notice}</div>}

            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={busy || recording} onClick={() => void toggle(true)}>
                    开始记录
                </Button>
                <Button size="sm" variant="secondary" disabled={busy || !recording} onClick={() => void toggle(false)}>
                    停止记录
                </Button>
                <Button size="sm" variant="danger" disabled={busy || !report || report.turns.length === 0} onClick={() => void clear()}>
                    清空全部
                </Button>
                <span className="numeric text-xs text-ink-faint">{report?.turns.length ?? 0} 条</span>
            </div>

            <div className="space-y-2">
                <div className="text-sm text-ink-soft">最近的对话（倒序，只读）</div>
                {!report || report.turns.length === 0 ? (
                    <div className="text-sm text-ink-faint">
                        {recording ? '还没有记录。孩子在探索里说话之后会出现在这里。' : '没有记录（还没打开开关）。'}
                    </div>
                ) : (
                    <ul className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                        {report.turns.map((turn) => (
                            <TurnRow key={turn.id} turn={turn} />
                        ))}
                    </ul>
                )}
            </div>
        </Card>
    )
}
