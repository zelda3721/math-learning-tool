import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History, LogOut } from 'lucide-react'

import { api } from './services/api'
import { useAgentRun } from './hooks/useAgentRun'
import { useAuth } from './auth/AuthContext'
import { AuthGate, SetupPage } from './auth/AuthScreens'
import { Badge } from './ui'
import { AtlasPage } from './atlas/AtlasPage'
import { PracticePage } from './practice/PracticePage'
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

type AppView = 'practice' | 'solve' | 'atlas' | 'mistakes' | 'explore' | 'ingest' | 'parent'

/** 角色导航：孩子只看学习面，家长全量（管理员） */
const NAV_ITEMS: { key: AppView; label: string; roles: ('parent' | 'child')[] }[] = [
    { key: 'practice', label: '练习', roles: ['parent', 'child'] },
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
        return <div className="min-h-screen flex items-center justify-center text-slate-400">正在启动……</div>
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
            {/* 统一顶栏：logo · 角色导航 · 用户区 */}
            <header className="sticky top-4 z-50 px-4 mb-4">
                <div className="soft-glass mx-auto max-w-6xl px-4 md:px-6 py-2.5 flex items-center gap-3">
                    <div className="flex items-center gap-2.5 shrink-0">
                        <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-400 to-indigo-500 flex items-center justify-center shadow-lg shadow-sky-200">
                            <span className="text-white font-bold text-lg">M</span>
                        </div>
                        <span className="hidden sm:inline font-bold text-lg text-slate-700 tracking-tight">
                            Math<span className="text-sky-500">Tutor</span>
                        </span>
                    </div>

                    <nav className="flex-1 flex items-center justify-center gap-0.5 overflow-x-auto">
                        {navItems.map(({ key, label }) => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setView(key)}
                                className={`px-3.5 md:px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors ${
                                    view === key
                                        ? 'bg-sky-500 text-white shadow'
                                        : 'text-slate-500 hover:text-slate-800'
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
                                className="p-2 text-slate-400 hover:text-sky-500 hover:bg-sky-50 rounded-full transition-all"
                                aria-label="历史记录"
                                title="历史记录"
                            >
                                <History size={17} />
                            </button>
                        )}
                        <span className="hidden md:inline text-sm font-semibold text-slate-600">{user?.username}</span>
                        <Badge tone={role === 'parent' ? 'amber' : 'sky'}>
                            {role === 'parent' ? '家长' : '同学'}
                        </Badge>
                        <button
                            type="button"
                            onClick={() => void logout()}
                            className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
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

            <main className={`flex-1 w-full max-w-5xl mx-auto px-4 py-8 md:py-12 flex-col gap-8 relative z-10 ${view === 'solve' ? 'flex' : 'hidden'}`}>
                {!isViewingHistory && (
                    <>
                        <section className="flex flex-col items-center text-center space-y-6 max-w-3xl mx-auto mt-8">
                            <div className="space-y-2">
                                <h1 className="text-hero leading-tight">
                                    让数学变得<br />
                                    <span className="text-sky-500">简单又有趣</span>
                                </h1>
                                <p className="text-slate-500 text-lg md:text-xl max-w-xl mx-auto">
                                    选择年级，输入题目，AI 老师一步步把它演成动画。
                                </p>
                            </div>

                            <div className="w-full h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent my-4" />

                            <div className="w-full">
                                <GradeSelector
                                    grades={gradesQuery.data || []}
                                    selectedGrade={selectedGrade}
                                    onSelect={setSelectedGrade}
                                    isLoading={gradesQuery.isLoading}
                                />
                            </div>
                        </section>

                        <section className="w-full max-w-3xl mx-auto space-y-4">
                            {/* 讲解双模式：动画（web 默认，秒级）/ 视频（Manim 高级成片） */}
                            <div className="flex justify-center">
                                <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white p-1">
                                    {(
                                        [
                                            ['anim', '⚡ 动画讲解（秒级）'],
                                            ['video', '🎬 视频讲解（Manim 高级）'],
                                        ] as const
                                    ).map(([m, label]) => (
                                        <button
                                            key={m}
                                            type="button"
                                            onClick={() => setExplainMode(m)}
                                            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                                                explainMode === m
                                                    ? 'bg-slate-800 text-white shadow'
                                                    : 'text-slate-500 hover:text-slate-800'
                                            }`}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="soft-glass p-1">
                                <div className="bg-white/50 rounded-[1.4rem] p-6 md:p-8 backdrop-blur-sm">
                                    <ProblemInput
                                        onSubmit={(problem) => handleSubmit(problem)}
                                        isLoading={isRunning}
                                        selectedGrade={selectedGrade}
                                        onGradeChange={setSelectedGrade}
                                        grades={gradesQuery.data || []}
                                    />
                                </div>
                            </div>
                            {explainMode === 'anim' && animRequest && (
                                <FreeExplainPanel
                                    key={`${animRequest.problem}-${animRequest.grade}`}
                                    problem={animRequest.problem}
                                    grade={animRequest.grade}
                                />
                            )}
                        </section>

                        <section className="w-full pb-20 space-y-6">
                            {isRunning && agentState.items.length === 0 && (
                                <div className="flex justify-center py-12">
                                    <LoadingAnimation />
                                </div>
                            )}

                            {(isRunning || isFinished) && <AgentTimeline state={agentState} />}

                            {isFinished && <LiveResult state={agentState} onReset={handleNewProblem} />}

                            {isFinished && agentState.sessionId && agentState.status === 'done' && (
                                <FeedbackBar
                                    sessionId={agentState.sessionId}
                                    hasManimCode={liveManimCodePresent}
                                    grade={selectedGrade}
                                />
                            )}
                        </section>
                    </>
                )}

                {isViewingHistory && historicalSession && (
                    <section className="pt-8 pb-20">
                        <HistoricalSessionView
                            detail={historicalSession}
                            onBack={handleNewProblem}
                        />
                    </section>
                )}

                {historicalLoading && (
                    <div className="flex justify-center py-12">
                        <LoadingAnimation />
                    </div>
                )}
                {historicalLoadError && (
                    <div className="soft-glass-panel p-6 border-l-4 border-red-400 bg-red-50/50">
                        <h3 className="font-semibold text-red-600 mb-1">加载历史失败</h3>
                        <p className="text-slate-600">{historicalLoadError}</p>
                    </div>
                )}
            </main>

            <SessionHistory
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                onSelect={handleSelectHistory}
                refreshKey={historyRefreshKey}
            />

            <footer className="py-6 text-center text-slate-400 text-sm">
                <p>© 2026 AI Math Tutor</p>
            </footer>
        </div>
    )
}

export default App
