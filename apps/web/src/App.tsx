import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History, LogOut } from 'lucide-react'

import { api } from './services/api'
import { useAgentRun } from './hooks/useAgentRun'
import { SLOGAN } from './brand'
import { useAuth } from './auth/AuthContext'
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

type AppView = 'practice' | 'ask' | 'solve' | 'atlas' | 'mistakes' | 'explore' | 'ingest' | 'parent'

/** 角色导航：孩子只看学习面，家长全量（管理员） */
const NAV_ITEMS: { key: AppView; label: string; roles: ('parent' | 'child')[] }[] = [
    { key: 'practice', label: '练习', roles: ['parent', 'child'] },
    { key: 'ask', label: '问一道题', roles: ['parent', 'child'] },
    { key: 'atlas', label: '星图', roles: ['parent', 'child'] },
    { key: 'mistakes', label: '错题本', roles: ['parent', 'child'] },
    { key: 'explore', label: '探索', roles: ['parent', 'child'] },
    { key: 'solve', label: '讲解', roles: ['parent'] },
    { key: 'ingest', label: '录题', roles: ['parent'] },
    { key: 'parent', label: '家长', roles: ['parent'] },
]

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
    const [animRequest, setAnimRequest] = useState<{ problem: string; grade: string } | null>(null)
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
        async (problem: string) => {
            setHistoricalSession(null)
            if (explainMode === 'anim') {
                setAnimRequest({ problem, grade: selectedGrade })
                return
            }
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
                <div className="mx-auto max-w-6xl px-4 md:px-6 h-14 flex items-center gap-3">
                    <div className="flex items-center gap-2.5 shrink-0">
                        <div className="w-8 h-8 rounded-[10px] bg-beam flex items-center justify-center">
                            <span className="text-white font-bold text-lg leading-none">M</span>
                        </div>
                        <span className="hidden sm:inline font-bold text-lg text-ink tracking-tight">
                            Math<span className="text-beam">Tutor</span>
                        </span>
                        {/* 口号与字标锁成一行。顶栏只有 56px 高，放不下第二行；
                            窄屏优先让导航，够宽才显示——完整登录页上一定看得到。 */}
                        <span
                            className="hidden xl:flex items-center gap-2.5 text-xs text-ink-faint whitespace-nowrap"
                            aria-hidden="true"
                        >
                            <span className="w-px h-3.5 bg-rule" />
                            {SLOGAN}
                        </span>
                    </div>

                    <nav className="flex-1 flex items-center justify-center gap-1 overflow-x-auto">
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
                                onSubmit={(problem) => handleSubmit(problem)}
                                isLoading={isRunning}
                                selectedGrade={selectedGrade}
                                onGradeChange={setSelectedGrade}
                                grades={gradesQuery.data || []}
                            />
                        </div>

                        {explainMode === 'anim' && animRequest && (
                            <FreeExplainPanel
                                key={`${animRequest.problem}-${animRequest.grade}`}
                                problem={animRequest.problem}
                                grade={animRequest.grade}
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
