import { useCallback, useMemo, useState } from 'react'
import { ArrowLeftRight, FlaskConical, Play } from 'lucide-react'

import { Badge, Button, Card, ErrorState, PageHeader } from '../ui'
import { AgentTimeline } from '../components'
import type { AgentRunState, TimelineItem } from '../types/agent'
import { compareLab, runLab, type LabCompareResult, type LabRunResult } from './api'

/**
 * AI 实验台（仅家长，PLAN 阶段 3 轻量版）。
 *
 * 这一页要回答的是一个具体问题：**同一句话，只动温度或换模型，产出差在哪**。
 * 所以界面上每一条信息都有用处——
 * - 提示词摘要：证明两次对比喂的是同一句话（否则对比不成立）；
 * - 模型 / 温度：这一路到底用什么参数跑的，不能靠记忆；
 * - 耗时：本地模型慢在哪里，是"想得久"还是"卡住了"，先看得见才谈得上调；
 * - 输出原文：不加工、不摘要，实验台展示的是模型真说了什么。
 *
 * 为什么只给家长：这里能任意写提示词并拿到模型原文，不经过安全层、不经过
 * 苏格拉底式约束（见 server 端 lab.ts 的说明）。孩子那边的每个入口都必须过这些闸。
 */

/** 与服务端 lab.ts 的 LAB_PROMPT_MAX 对齐；真正的上限在服务端，这里只是别让人白打 */
const PROMPT_MAX = 2000

/** 卡片内输入框：与 .input-hero 同源，尺寸收紧一档 */
const fieldCls =
    'w-full px-3 py-2 text-sm text-ink bg-plate border border-rule rounded-[10px] placeholder:text-ink-faint focus:outline-none focus:border-beam focus:ring-2 focus:ring-beam-wash transition-colors'

/** 默认提示词用产品自己的题：打开就能跑，不必先想一句话来试 */
const DEFAULT_PROMPT = '用三年级孩子能听懂的话解释：为什么 1/2 比 1/3 大？'

type Mode = 'single' | 'compare'

/** 提示词摘要：折成一行、超长截断——对比时它只用来确认"两边喂的是同一句" */
function summarize(text: string, max = 60): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 耗时的读法：比"两个数字"更能看出差别的是一句话 */
function deltaText(result: LabCompareResult): string {
    if (result.a.error && result.b.error) return '两边都失败了'
    if (result.a.error) return 'A 路失败，只有 B 路跑出来了'
    if (result.b.error) return 'B 路失败，只有 A 路跑出来了'
    const abs = Math.abs(result.deltaMs)
    if (abs < 10) return '两边耗时几乎一样'
    const slower = result.deltaMs > 0 ? 'B' : 'A'
    const base = result.deltaMs > 0 ? result.a.ms : result.b.ms
    const pct = base > 0 ? Math.round((abs / base) * 100) : 0
    return `${slower} 慢了 ${abs} ms（约 ${pct}%）`
}

/** 一路参数：温度滑杆 + 可选模型名 */
function SideControls({
    label,
    temperature,
    onTemperature,
    model,
    onModel,
}: {
    label: string
    temperature: number
    onTemperature: (v: number) => void
    model: string
    onModel: (v: string) => void
}) {
    return (
        <div className="rounded-[10px] border border-rule bg-paper p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">{label}</span>
                <Badge tone="slate">
                    温度 <span className="numeric ml-1">{temperature.toFixed(1)}</span>
                </Badge>
            </div>

            <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => onTemperature(Number(e.target.value))}
                className="w-full accent-beam"
                aria-label={`${label} 温度`}
            />
            <div className="flex justify-between text-[11px] text-ink-faint">
                <span>0 · 最确定</span>
                <span>2 · 最发散</span>
            </div>

            <label className="block space-y-1.5">
                <span className="eyebrow block">模型（可留空）</span>
                <input
                    className={fieldCls}
                    value={model}
                    onChange={(e) => onModel(e.target.value)}
                    placeholder="留空 = .env 里的默认模型"
                    maxLength={120}
                />
            </label>
        </div>
    )
}

/**
 * 一次调用的结果卡：参数徽章 + 复用 AgentTimeline 展示这次说了什么。
 *
 * 复用 AgentTimeline 而不是另写一套输出框：它本来就是"纸面上的一次轨迹"，
 * 实验台的一次调用是它的退化情形（没有工具调用，只有一段消息）。
 */
function RunCard({ label, result }: { label: string; result: LabRunResult }) {
    const state = useMemo<AgentRunState>(() => {
        const items: TimelineItem[] = result.reply.trim()
            ? [{ kind: 'message', key: `${label}-reply`, text: result.reply }]
            : []
        return {
            sessionId: null,
            status: result.error ? 'failed' : 'done',
            items,
            finalVideoUrl: null,
            subtitleUrl: null,
            finalText: result.reply,
            error: result.error ?? null,
        }
    }, [label, result])

    return (
        <div className="plate p-4 space-y-3 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow">{label}</span>
                <Badge tone="beam">{result.model}</Badge>
                <Badge tone="slate">
                    温度 <span className="numeric ml-1">{result.temperature ?? '默认'}</span>
                </Badge>
                <Badge tone="slate">
                    <span className="numeric">{result.ms}</span> ms
                </Badge>
                {/* 数据到底出没出这台机器，是家长最该一眼看到的一条 */}
                {result.localOnly ? (
                    <Badge tone="correct">本地端点</Badge>
                ) : (
                    <Badge tone="wrong">云端（已记审计）</Badge>
                )}
            </div>

            <AgentTimeline state={state} title="这一次调用" />

            {!result.error && result.reply.trim().length === 0 && (
                <p className="text-sm text-ink-faint">模型回了一段空文本（可能预算被思考吃掉了）。</p>
            )}
        </div>
    )
}

export function LabPage() {
    const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
    const [mode, setMode] = useState<Mode>('single')
    const [temperatureA, setTemperatureA] = useState(0.2)
    const [temperatureB, setTemperatureB] = useState(1.2)
    const [modelA, setModelA] = useState('')
    const [modelB, setModelB] = useState('')
    const [running, setRunning] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [single, setSingle] = useState<LabRunResult | null>(null)
    const [compare, setCompare] = useState<LabCompareResult | null>(null)

    const canRun = prompt.trim().length > 0 && !running

    const submit = useCallback(async () => {
        if (!prompt.trim() || running) return
        setRunning(true)
        setError(null)
        setSingle(null)
        setCompare(null)
        try {
            if (mode === 'single') {
                setSingle(await runLab({ prompt, temperature: temperatureA, model: modelA }))
            } else {
                // 两路共用一个提示词：对比要成立，唯一能变的是参数
                setCompare(
                    await compareLab({
                        prompt,
                        a: { temperature: temperatureA, model: modelA },
                        b: { temperature: temperatureB, model: modelB },
                    })
                )
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setRunning(false)
        }
    }, [prompt, running, mode, temperatureA, temperatureB, modelA, modelB])

    return (
        <div className="space-y-6 pb-16">
            <PageHeader
                title="AI 实验台"
                subtitle="同一句话，只动温度或换个模型——产出差在哪，当场看得见"
            />

            <Card className="space-y-4">
                <label className="block space-y-1.5">
                    <span className="eyebrow block">提示词</span>
                    <textarea
                        className={`${fieldCls} min-h-[96px] resize-y leading-relaxed`}
                        value={prompt}
                        maxLength={PROMPT_MAX}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="例如：用三年级孩子能听懂的话解释为什么 1/2 比 1/3 大"
                    />
                    <span className="flex justify-between text-xs text-ink-faint">
                        <span>实验台直接问模型，不经过判卷与安全层——所以只放在家长这边。</span>
                        <span className="numeric">
                            {prompt.length} / {PROMPT_MAX}
                        </span>
                    </span>
                </label>

                <div className="space-y-1.5">
                    <span className="eyebrow block">模式</span>
                    <div className="inline-flex items-center gap-1 rounded-[10px] border border-rule bg-paper p-1">
                        {(
                            [
                                ['single', '跑一次'],
                                ['compare', '对比两种设置'],
                            ] as const
                        ).map(([m, label]) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setMode(m)}
                                className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[8px] text-sm font-medium transition-colors ${
                                    mode === m ? 'bg-beam text-white' : 'text-ink-faint hover:text-ink'
                                }`}
                            >
                                {m === 'single' ? <Play size={13} /> : <ArrowLeftRight size={13} />}
                                {label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className={mode === 'compare' ? 'grid gap-4 md:grid-cols-2' : ''}>
                    <SideControls
                        label={mode === 'compare' ? 'A 路' : '参数'}
                        temperature={temperatureA}
                        onTemperature={setTemperatureA}
                        model={modelA}
                        onModel={setModelA}
                    />
                    {mode === 'compare' && (
                        <SideControls
                            label="B 路"
                            temperature={temperatureB}
                            onTemperature={setTemperatureB}
                            model={modelB}
                            onModel={setModelB}
                        />
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={() => void submit()} disabled={!canRun}>
                        {running ? '正在等模型……' : mode === 'single' ? '跑一次' : '对比两种设置'}
                    </Button>
                    <span className="text-xs text-ink-faint">
                        本页同样受 LOCAL_ONLY 约束：只连本机/局域网的端点。
                    </span>
                </div>
            </Card>

            {error && <ErrorState message={error} />}

            {single && mode === 'single' && (
                <Card className="space-y-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                        <span className="eyebrow">提示词摘要</span>
                        <span className="text-sm text-ink-soft">{summarize(prompt)}</span>
                    </div>
                    <RunCard label="跑一次" result={single} />
                </Card>
            )}

            {compare && mode === 'compare' && (
                <Card className="space-y-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                        <span className="eyebrow">提示词摘要</span>
                        <span className="text-sm text-ink-soft">{summarize(compare.prompt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                        <FlaskConical size={14} className="text-ink-faint" />
                        {deltaText(compare)}
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                        <RunCard label="A 路" result={compare.a} />
                        <RunCard label="B 路" result={compare.b} />
                    </div>
                </Card>
            )}
        </div>
    )
}
