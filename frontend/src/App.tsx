import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'

import { api } from './services/api'
import { useAgentRun } from './hooks/useAgentRun'
import type { PersistedSession, SessionDetail } from './types/agent'

import {
    Header,
    GradeSelector,
    ProblemInput,
    LoadingAnimation,
    AgentTimeline,
    LiveResult,
    FeedbackBar,
    SessionHistory,
    HistoricalSessionView,
} from './components'

function App() {
    const [selectedGrade, setSelectedGrade] = useState<string>('elementary_upper')
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
            await startAgent({ problem, grade: selectedGrade })
            setHistoryRefreshKey((k) => k + 1)
        },
        [selectedGrade, startAgent]
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
        (it) => it.kind === 'tool' && it.name === 'generate_manim_code' && it.status === 'success'
    )

    return (
        <div className="min-h-screen flex flex-col relative overflow-hidden">
            <Header />

            <button
                onClick={() => setHistoryOpen(true)}
                className="fixed top-4 right-4 md:top-6 md:right-6 z-30 bg-white/80 backdrop-blur border border-slate-200 shadow-sm hover:shadow-md hover:border-sky-300 transition rounded-full px-4 py-2 text-sm text-slate-600 hover:text-sky-600 inline-flex items-center gap-2"
            >
                <History size={16} />
                历史
            </button>

            <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-8 md:py-12 flex flex-col gap-8 relative z-10">
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

                        <section className="w-full max-w-3xl mx-auto">
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
                <p>© 2026 AI Math Tutor • Harness Agent Edition</p>
            </footer>
        </div>
    )
}

export default App
