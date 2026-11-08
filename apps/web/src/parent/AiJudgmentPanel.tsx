import { useCallback, useEffect, useState } from 'react'

import { Badge, Button, Card } from '../ui'
import { fetchAiJudgments, postAiJudgment, type AiJudgmentItem } from './api'

/**
 * 家长中心里的「AI 判断抽查」面板。
 *
 * 这一队不是"判不准的题"（那是判卷抽检），而是 **AI 已经说过话、却拿不出可复核依据**
 * 的作答：例如孩子写了一段推理，规则判不出来，模型说"意思等价"就算对了。
 * 按宪法第 5 条，这类证据**永远不进掌握度**——这里能做的只有两件事：
 * 看一眼，或者推翻它（推翻后会回到判卷抽检队列，由家长自己给结论）。
 *
 * 为什么"推翻"也不改掌握度：它本来就不承重，推翻只是把这条证据的处置权收回来，
 * 不是把它变成一条能点亮星图的证据。
 */

const SOURCE_LABEL: Record<string, string> = {
    daily: '课后练习',
    classroom: '课堂',
    probe: '探针',
    variant: '变式',
    review: '复习',
    photo: '拍照作答',
}

export function AiJudgmentPanel({ learnerId }: { learnerId: string }) {
    const [items, setItems] = useState<AiJudgmentItem[] | null>(null)
    const [note, setNote] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})

    const load = useCallback(async () => {
        setError(null)
        try {
            const body = await fetchAiJudgments(learnerId)
            setItems(body.items)
            setNote(body.note ?? null)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        }
    }, [learnerId])

    useEffect(() => {
        setItems(null)
        setNotice(null)
        void load()
    }, [load])

    const act = async (item: AiJudgmentItem, action: 'reviewed' | 'overturn') => {
        setBusyId(item.attemptId)
        setError(null)
        try {
            await postAiJudgment({
                attemptId: item.attemptId,
                action,
                ...(noteDraft[item.attemptId]?.trim() ? { note: noteDraft[item.attemptId]!.trim() } : {}),
            })
            setNotice(action === 'overturn' ? '已标为需复核，回到判卷抽检队列' : '已标记为看过')
            await load()
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusyId(null)
        }
    }

    const pending = (items ?? []).filter((i) => !i.judgement).length

    return (
        <Card className="p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-ink">AI 判断抽查</h3>
                <Badge tone={pending > 0 ? 'amber' : 'slate'}>待看 {pending} 条</Badge>
            </div>

            <p className="text-sm text-ink-soft leading-relaxed">
                AI 判过的作答：有可复核依据的（验算、标准答案）不在这里；
                这里只有「凭模型一句话就算对」的那些，它们**不计入掌握度**，只作为练习记录。
                你看一眼、或者推翻它，掌握度都不会因此变化。
            </p>

            {error && <div className="text-sm text-[color:var(--color-wrong)]">{error}</div>}
            {notice && <div className="text-sm text-[color:var(--color-correct)]">{notice}</div>}
            {note && <div className="text-xs text-ink-faint">{note}</div>}

            {items === null ? (
                <div className="text-sm text-ink-faint">正在加载……</div>
            ) : items.length === 0 ? (
                <div className="text-sm text-ink-faint">还没有 AI 判断的作答。规则判得出来的时候不会有。</div>
            ) : (
                <ul className="space-y-3">
                    {items.map((item) => (
                        <li key={item.attemptId} className="rounded-[10px] border border-rule bg-paper p-4 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm text-ink font-medium">{item.stem}</span>
                                <Badge tone={item.judgement ? 'slate' : 'amber'}>
                                    {item.judgement
                                        ? item.judgement.action === 'overturn'
                                            ? '已推翻'
                                            : '已看过'
                                        : '待抽查'}
                                </Badge>
                                {item.needsReview && <Badge tone="beam">等复核</Badge>}
                                <span className="numeric text-xs text-ink-faint ml-auto">
                                    {new Date(item.at).toLocaleString('zh-CN', { hour12: false })}
                                </span>
                            </div>

                            <div className="text-sm text-ink-soft">
                                孩子的答案：<span className="text-ink">{item.studentAnswer || '（空）'}</span>
                            </div>
                            <div className="text-sm text-ink-soft">
                                判卷依据：<span className="text-ink-faint">{item.basis}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                                <span>AI 判为{item.correct ? '对' : '错'}</span>
                                <span>·</span>
                                <span>{SOURCE_LABEL[item.source] ?? item.source}</span>
                                {item.hintLevelUsed > 0 && <span>· 用了 {item.hintLevelUsed} 级提示</span>}
                                {item.judgement?.note && <span>· 你的备注：{item.judgement.note}</span>}
                            </div>

                            {!item.judgement && (
                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                    <input
                                        type="text"
                                        value={noteDraft[item.attemptId] ?? ''}
                                        onChange={(e) =>
                                            setNoteDraft((prev) => ({ ...prev, [item.attemptId]: e.target.value }))
                                        }
                                        placeholder="备注（可留空）"
                                        className="flex-1 min-w-40 px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px] focus:outline-none focus:border-beam focus:ring-2 focus:ring-beam-wash"
                                    />
                                    <Button
                                        size="sm"
                                        disabled={busyId === item.attemptId}
                                        onClick={() => void act(item, 'reviewed')}
                                    >
                                        看过
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        disabled={busyId === item.attemptId}
                                        onClick={() => void act(item, 'overturn')}
                                    >
                                        推翻
                                    </Button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    )
}
