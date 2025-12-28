import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from './services/api'

// Components
// Components
import {
  Header,
  GradeSelector,
  ProblemInput,
  ResultDisplay,
  LoadingAnimation
} from './components'

function App() {
  const [selectedGrade, setSelectedGrade] = useState<string>('elementary_upper')

  // Queries
  const gradesQuery = useQuery({
    queryKey: ['grades'],
    queryFn: () => api.getGrades(),
  })

  // Mutations
  const solveMutation = useMutation({
    mutationFn: (problem: string) =>
      api.processProblem({ problem, grade: selectedGrade }),
  })

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Dynamic Background Orbs (Adding more via JS/CSS if needed, but CSS handles base) */}

      <Header />

      <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-8 md:py-12 flex flex-col gap-8 relative z-10">

        {/* Hero Section */}
        <section className="flex flex-col items-center text-center space-y-6 max-w-3xl mx-auto mt-8">
          <div className="space-y-2">
            <h1 className="text-hero leading-tight">
              让数学变得<br /><span className="text-sky-500">简单又有趣</span>
            </h1>
            <p className="text-slate-500 text-lg md:text-xl max-w-xl mx-auto">
              选择年级，输入题目，我会一步步教你解题，就像看动画片一样简单。
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

        {/* Interaction Section */}
        <section className="w-full max-w-3xl mx-auto">
          <div className="soft-glass p-1"> {/* Glass wrapper for polish */}
            <div className="bg-white/50 rounded-[1.4rem] p-6 md:p-8 backdrop-blur-sm">
              <ProblemInput
                onSubmit={(problem) => solveMutation.mutate(problem)}
                isLoading={solveMutation.isPending}
                selectedGrade={selectedGrade}
                onGradeChange={setSelectedGrade}
                grades={gradesQuery.data || []}
              />
            </div>
          </div>
        </section>

        {/* Results Section */}
        <section className="w-full pb-20">
          {solveMutation.isPending && (
            <div className="flex justify-center py-12">
              <LoadingAnimation />
            </div>
          )}

          {solveMutation.isError && (
            <div className="soft-glass-panel p-6 border-l-4 border-red-400 bg-red-50/50">
              <h3 className="font-semibold text-red-600 mb-1">出错了</h3>
              <p className="text-slate-600">{solveMutation.error.message}</p>
            </div>
          )}

          {solveMutation.isSuccess && solveMutation.data && (
            <ResultDisplay result={solveMutation.data} />
          )}
        </section>

      </main>

      {/* Simple Footer */}
      <footer className="py-6 text-center text-slate-400 text-sm">
        <p>© 2025 AI Math Tutor • Luminous Horizon Edition</p>
      </footer>
    </div>
  )
}

export default App
