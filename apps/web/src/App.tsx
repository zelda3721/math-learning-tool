import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History, LogOut } from 'lucide-react'

import { api } from './services/api'
import { useAgentRun } from './hooks/useAgentRun'
import { SLOGAN } from './brand'
import { useAuth } from './auth/AuthContext'
import { useLearner } from './learner/LearnerContext'
import { AuthGate, SetupPage } from './auth/AuthScreens'
import { Badge, ErrorState, PageHeader } from './ui'
import { AtlasPage } from './atlas/AtlasPage'
import { PracticePage } from './practice/PracticePage'
import { AskPage } from './ask/AskPage'
import { IngestPage } from './ingest/IngestPage'
import { MistakeBook } from './mistakes/MistakeBook'
import { ExplorePage } from './explore/ExplorePage'
import { ParentPage } from './parent/ParentPage'
import { FreeExplainPanel } from './solve/FreeExplainPanel'
import type { PersistedSession, SessionDetail } from './types/agent'
import { BankPage } from './bank/BankPage'

import {
    GradeSelector,
    ProblemInput,
    LoadingAnimation,
    AgentTimeline,
    LiveResult,
    FeedbackBar,
    SessionHistory,
    HistoricalSessionView,
} from './components'

type AppView = 'practice' | 'ask' | 'solve' | 'atlas' | 'mistakes' | 'explore' | 'ingest' | 'bank' | 'parent'

/** 角色导航：孩子只看学习面，家长全量（管理员） */
const NAV_ITEMS: { key: AppView; label: string; roles: ('parent' | 'child')[] }[] = [
    { key: 'practice', label: '练习', roles: ['parent', 'child'] },
    { key: 'ask', label: '问一道题', roles: ['parent', 'child'] },
    { key: 'atlas', label: '星图', roles: ['parent', 'child'] },
    { key: 'mistakes', label: '错题本', roles: ['parent', 'child'] },
    { key: 'explore', label: '探索', roles: ['parent', 'child'] },
    { key: 'solve', label: '讲解', roles: ['parent'] },
    { key: 'ingest', label: '录题', roles: ['parent'] },
    { key: 'bank', label: '题库', roles: ['parent'] },
    { key: 'parent', label: '家长', roles: ['parent'] },
]

/**
 * 待批改条数：挂在「家长」导航上的角标。
 *
 * 判不准的作答会转给家长（"这道题已交给家长确认"），可此前转过去就没下文了——
 * 家长得自己想起来去翻。一个数字就能把这条路接上。
 */
function usePendingVerdicts(enabled: boolean, learnerId: string | undefined) {
    const [count, setCount] = useState(0)
    useEffect(() => {
        if (!enabled || !learnerId) {
            setCount(0)
            return
        }
        let cancelled = false
        const load = () =>
            fetch(`/api/v1/parent/pending-count?learnerId=${encodeURIComponent(learnerId)}`)
                .then((r) => (r.ok ? r.json() : { count: 0 }))
                .then((b: { count?: number }) => {
                    if (!cancelled) setCount(typeof b.count === 'number' ? b.count : 0)
                })
                .catch(() => {
                    /* 角标是锦上添花，拉不到就不显示 */
                })
        void load()
        // 孩子边做题边产生待批改，30 秒一次足够让家长察觉，又不至于打扰服务端
        const timer = window.setInterval(() => void load(), 30_000)
        return () => {
            cancelled = true
            window.clearInterval(timer)
        }
    }, [enabled, learnerId])
    return count
}

function App() {
    const { status } = useAuth()
    if (status === 'loading') {
        return <div className="min-h-screen flex items-center justify-center text-ink-faint">正在启动……</div>
    }
    if (status === 'setup') return <SetupPage />
    if (status === 'anon') return <AuthGate />
    return <AuthedApp />
}

function AuthedApp() {
    const { user, logout } = useAuth()
    const [view, setView] = useState<AppView>('practice')
    const role = user?.role ?? 'child'
    const navItems = NAV_ITEMS.filter((item) => item.roles.includes(role))
    const { learner } = useLearner()
    // 待批改只对家长有意义——孩子不该给自己判卷
    const pendingVerdicts = usePendingVerdicts(role === 'parent', learner?.id)

    // 角色变化 / 越权视图兜底：回练习页
    useEffect(() => {
        if (!navItems.some((item) => item.key === view)) setView('practice')
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [role])

    // 页面内跳转（如小结页的「去星图看看」）：只接受当前角色可见的视图
    useEffect(() => {
        const onNavigate = (e: Event) => {
            const target = (e as CustomEvent<{ view?: string }>).detail?.view
            if (target && NAV_ITEMS.some((i) => i.key === target && i.roles.includes(role))) {
                setView(target as AppView)
                window.scrollTo({ top: 0, behavior: 'smooth' })
            }
        }
        window.addEventListener('mathtutor:navigate', onNavigate)
        return () => window.removeEventListener('mathtutor:navigate', onNavigate)
    }, [role])
    const [selectedGrade, setSelectedGrade] = useState<string>('elementary_upper')
    // 讲解 tab 的双模式：⚡ 动画（web 默认，秒级）/ 🎬 视频（Manim 高级成片）
    const [explainMode, setExplainMode] = useState<'anim' | 'video'>('anim')
    const [animRequest, setAnimRequest] = useState<{
        problem: string
        grade: string
        /** 拍题识别裁出的题干配图（data URL）；讲解拿它当底图 */
        figureImage?: string
    } | null>(null)
    const [historyOpen, setHistoryOpen] = useState(false)
    const [historyRefreshKey, setHistoryRefreshKey] = useState(0)
    const [historicalSession, setHistoricalSession] = useState<SessionDetail | null>(null)
    const [historicalLoadError, setHistoricalLoadError] = useState<string | null>(null)
    const [historicalLoading, setHistoricalLoading] = useState(false)

    const gradesQuery = useQuery({
        queryKey: ['grades'],
        queryFn: () => api.getGrades(),
    })

    const { state: agentState, start: startAgent, reset: resetAgent } = useAgentRun()

    const isRunning = agentState.status === 'running'
    const isFinished =
        agentState.status === 'done' ||
        agentState.status === 'exhausted' ||
        agentState.status === 'failed'
    const isViewingHistory = historicalSession !== null

    const handleSubmit = useCallback(
        async (problem: string, figureImage?: string) => {
            setHistoricalSession(null)
            if (explainMode === 'anim') {
                setAnimRequest({ problem, grade: selectedGrade, figureImage })
                return
            }
            // 视频（agent/chat）那条路暂不吃图——引擎 /chat 契约里没有图片入参；
            // 拍照识别出的题干文本照常生效，配图只在动画讲解里用
            setAnimRequest(null)
            await startAgent({ problem, grade: selectedGrade })
            setHistoryRefreshKey((k) => k + 1)
        },
        [explainMode, selectedGrade, startAgent]
    )

    const handleNewProblem = useCallback(() => {
        setHistoricalSession(null)
        resetAgent()
    }, [resetAgent])

    const handleSelectHistory = useCallback(async (session: PersistedSession) => {
        setHistoryOpen(false)
        setHistoricalLoading(true)
        setHistoricalLoadError(null)
        try {
            const detail = await api.getSession(session.id)
            setHistoricalSession(detail)
            resetAgent()
        } catch (err) {
            setHistoricalLoadError(err instanceof Error ? err.message : String(err))
        } finally {
            setHistoricalLoading(false)
        }
    }, [resetAgent])

    const liveManimCodePresent = agentState.items.some(
        (it) =>
            it.kind === 'tool' &&
            ['generate_manim_code', 'compile_video'].includes(it.name) &&
            it.status === 'success'
    )

    return (
        <div className="min-h-screen flex flex-col relative overflow-hidden">
            {/* 统一顶栏：贴合纸面的横轨 —— logo · 角色导航 · 用户区 */}
            <header className="top-rail sticky top-0 z-50 mb-6">
                <div className="mx-auto max-w-6xl px-4 md:px-6 h-16 md:h-[4.5rem] flex items-center gap-3">
                    {/* 标识锁定：方章 + 字标，口号在字标正下方另起一行。
                        排成一行时它把顶栏挤出了横向滚动条——竖排比横排窄一截，
                        顶栏也随之加高到 72px 容下两行。 */}
                    <div className="flex items-center gap-2.5 shrink-0">
                        <div className="w-9 h-9 rounded-[10px] bg-beam flex items-center justify-center shrink-0">
                            <span className="text-white font-bold text-lg leading-none">M</span>
                        </div>
                        <div className="hidden sm:flex flex-col justify-center leading-none">
                            <span className="font-bold text-lg text-ink tracking-tight">
                                Math<span className="text-beam">Tutor</span>
                            </span>
                            <span
                                className="hidden lg:block text-[11px] text-ink-faint whitespace-nowrap mt-1"
                                aria-hidden="true"
                            >
                                {SLOGAN}
                            </span>
                        </div>
                    </div>

                    {/* min-w-0 是关键：flex 子项默认 min-width:auto，装不下时会把整条顶栏
                        撑宽而不是让 overflow-x-auto 生效——那正是横向滚动条的来源。 */}
                    <nav className="flex-1 min-w-0 flex items-center justify-center gap-1 overflow-x-auto">
                        {navItems.map(({ key, label }) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setView(key)}
                                className={`px-3.5 md:px-4 py-1.5 rounded-[10px] text-sm font-semibold whitespace-nowrap transition-colors ${
                                    view === key
                                        ? 'bg-beam text-white'
                                        : 'text-ink-soft hover:text-ink hover:bg-paper'
                                }`}
                            >
                                {label}
                                {/* 有作答等着家长判，导航上就得看得见——
                                    不然孩子那句"已交给家长确认"就没有下文了 */}
                                {key === 'parent' && pendingVerdicts > 0 && (
                                    <span
                                        className={`ml-1.5 inline-flex min-w-[18px] justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold numeric ${
                                            view === key
                                                ? 'bg-white/25 text-white'
                                                : 'bg-wrong text-white'
                                        }`}
                                    >
                                        {pendingVerdicts}
                                    </span>
                                )}
                            </button>
                        ))}
                    </nav>

                    <div className="flex items-center gap-2 shrink-0">
                        {view === 'solve' && (
                            <button
                                type="button"
                                onClick={() => setHistoryOpen(true)}
                                className="p-2 text-ink-faint hover:text-beam hover:bg-beam-wash rounded-[10px] transition-colors"
                                aria-label="历史记录"
                                title="历史记录"
                            >
                                <History size={17} />
                            </button>
                        )}
                        <span className="hidden md:inline text-sm font-semibold text-ink-soft">{user?.username}</span>
                        <Badge tone={role === 'parent' ? 'beam' : 'slate'}>
                            {role === 'parent' ? '家长' : '同学'}
                        </Badge>
                        <button
                            type="button"
                            onClick={() => void logout()}
                            className="p-2 text-ink-faint hover:text-wrong hover:bg-wrong-wash rounded-[10px] transition-colors"
                            aria-label="退出登录"
                            title="退出登录"
                        >
                            <LogOut size={17} />
                        </button>
                    </div>
                </div>
            </header>

            {view === 'practice' && (
                <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-8 relative z-10">
                    <PracticePage />
                </main>
            )}

            {view === 'ask' && (
                <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-8 relative z-10">
                    <AskPage />
                </main>
            )}

            {view === 'mistakes' && (
                <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-8 relative z-10">
                    <MistakeBook />
                </main>
            )}

            {view === 'explore' && (
                <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-8 relative z-10">
                    <ExplorePage />
                </main>
            )}

            {view === 'ingest' && (
                <main className="flex-1 w-full max-w-4xl mx-auto px-4 py-8 relative z-10">
                    <IngestPage />
                </main>
            )}

            {view === 'bank' && (
                <main className="flex-1 w-full max-w-4xl mx-auto px-4 py-8 relative z-10">
                    <BankPage />
                </main>
            )}

            {view === 'parent' && (
                <main className="flex-1 w-full max-w-4xl mx-auto px-4 py-8 relative z-10">
                    <ParentPage />
                </main>
            )}

            {view === 'atlas' && (
                <main className="flex-1 w-full max-w-[1400px] mx-auto px-4 py-4 relative z-10">
                    <AtlasPage />
                </main>
            )}

            <main className={`flex-1 w-full max-w-5xl mx-auto px-4 py-8 flex-col relative z-10 ${view === 'solve' ? 'flex' : 'hidden'}`}>
                <PageHeader title="讲解" subtitle="任意一道题，先看动画讲解；需要成片再生成视频" />

                {!isViewingHistory && (
                    <div className="space-y-6 pb-16">
                        {/* 工作台：年级 + 模式 + 题目，一张图版里说清一件事 */}
                        <div className="plate p-5 md:p-6 space-y-4">
                            <div className="flex flex-wrap items-start justify-between gap-4">
                                <GradeSelector
                                    grades={gradesQuery.data || []}
                                    selectedGrade={selectedGrade}
                                    onSelect={setSelectedGrade}
                                    isLoading={gradesQuery.isLoading}
                                />

                                {/* 讲解双模式：动画（web 默认，秒级）/ 视频（Manim 高级成片） */}
                                <div className="space-y-1.5">
                                    <span className="eyebrow block">讲解形式</span>
                                    <div className="inline-flex items-center gap-1 rounded-[10px] border border-rule bg-paper p-1">
                                        {(
                                            [
                                                ['anim', '动画 · 秒级'],
                                                ['video', '视频 · Manim'],
                                            ] as const
                                        ).map(([m, label]) => (
                                            <button
                                                key={m}
                                                type="button"
                                                onClick={() => setExplainMode(m)}
                                                className={`px-3.5 py-1.5 rounded-[8px] text-sm font-medium transition-colors ${
                                                    explainMode === m
                                                        ? 'bg-beam text-white'
                                                        : 'text-ink-faint hover:text-ink'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <ProblemInput
                                onSubmit={(problem, figureImage) => handleSubmit(problem, figureImage)}
                                isLoading={isRunning}
                                selectedGrade={selectedGrade}
                                onGradeChange={setSelectedGrade}
                                grades={gradesQuery.data || []}
                            />
                        </div>

                        {explainMode === 'anim' && animRequest && (
                            <FreeExplainPanel
                                // 同题不同图也要重挂：图变了讲解底图就得跟着变
                                key={`${animRequest.problem}-${animRequest.grade}-${animRequest.figureImage?.length ?? 0}`}
                                problem={animRequest.problem}
                                grade={animRequest.grade}
                                figureImage={animRequest.figureImage}
                            />
                        )}

                        {isRunning && agentState.items.length === 0 && <LoadingAnimation />}

                        {(isRunning || isFinished) && <AgentTimeline state={agentState} />}

                        {isFinished && <LiveResult state={agentState} onReset={handleNewProblem} />}

                        {isFinished && agentState.sessionId && agentState.status === 'done' && (
                            <FeedbackBar
                                sessionId={agentState.sessionId}
                                hasManimCode={liveManimCodePresent}
                                grade={selectedGrade}
                            />
                        )}
                    </div>
                )}

                {isViewingHistory && historicalSession && (
                    <div className="pb-16">
                        <HistoricalSessionView detail={historicalSession} onBack={handleNewProblem} />
                    </div>
                )}

                {historicalLoading && <LoadingAnimation text="正在打开历史会话" />}
                {historicalLoadError && (
                    <ErrorState message={`加载历史失败：${historicalLoadError}`} />
                )}
            </main>

            <SessionHistory
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                onSelect={handleSelectHistory}
                refreshKey={historyRefreshKey}
            />

            <footer className="py-6 text-center text-ink-faint text-sm">
                <p>© 2026 AI Math Tutor</p>
            </footer>
        </div>
    )
}

export default App
