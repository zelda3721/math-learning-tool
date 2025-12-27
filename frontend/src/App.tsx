import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, ProcessProblemResponse, Grade } from './services/api'

// Components
import { Header } from './components/Header'
import { GradeSelector } from './components/GradeSelector'
import { ProblemInput } from './components/ProblemInput'
import { ResultDisplay } from './components/ResultDisplay'
import { LoadingAnimation } from './components/LoadingAnimation'

function App() {
  const [selectedGrade, setSelectedGrade] = useState('elementary_upper')
  const [result, setResult] = useState<ProcessProblemResponse | null>(null)

  // Fetch grades
  const { data: grades, isLoading: gradesLoading } = useQuery<Grade[]>({
    queryKey: ['grades'],
    queryFn: api.getGrades,
  })

  // Process problem mutation
  const processMutation = useMutation({
    mutationFn: (problem: string) =>
      api.processProblem({ problem, grade: selectedGrade }),
    onSuccess: (data) => {
      setResult(data)
    },
  })

  const handleSubmit = (problem: string) => {
    setResult(null)
    processMutation.mutate(problem)
  }

  return (
    <div className="min-h-screen">
      <Header />

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Grade Selector */}
        <section className="mb-8">
          <GradeSelector
            grades={grades || []}
            selectedGrade={selectedGrade}
            onSelect={setSelectedGrade}
            isLoading={gradesLoading}
          />
        </section>

        {/* Problem Input */}
        <section className="mb-8">
          <ProblemInput
            onSubmit={handleSubmit}
            isLoading={processMutation.isPending}
          />
        </section>

        {/* Loading State */}
        {processMutation.isPending && (
          <section className="mb-8">
            <LoadingAnimation />
          </section>
        )}

        {/* Results */}
        {result && (
          <section>
            <ResultDisplay result={result} />
          </section>
        )}

        {/* Error */}
        {processMutation.isError && (
          <div className="glass p-6 border-red-500/30">
            <p className="text-red-400">
              处理失败: {(processMutation.error as Error).message}
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
