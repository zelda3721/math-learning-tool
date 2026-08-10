import { History } from 'lucide-react'

interface HeaderProps {
    onOpenHistory?: () => void
    /** 历史记录只对「讲解」视图有意义（引擎会话历史），其余视图隐藏 */
    showHistory?: boolean
}

export function Header({ onOpenHistory, showHistory = false }: HeaderProps = {}) {
    return (
        <header className="sticky top-4 z-50 px-4 mb-4">
            <div className="soft-glass mx-auto max-w-5xl px-6 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-400 to-indigo-500 flex items-center justify-center shadow-lg shadow-sky-200">
                        <span className="text-white font-bold text-lg">M</span>
                    </div>
                    <span className="font-bold text-lg text-slate-700 tracking-tight">
                        Math<span className="text-sky-500">Tutor</span>
                    </span>
                </div>

                {showHistory && (
                    <button
                        type="button"
                        onClick={onOpenHistory}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors"
                    >
                        <History size={15} />
                        历史记录
                    </button>
                )}
            </div>
        </header>
    )
}
