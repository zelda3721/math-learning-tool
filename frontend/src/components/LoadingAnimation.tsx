import { BrainCircuit, Calculator, Shapes } from 'lucide-react'

export function LoadingAnimation() {
    return (
        <div className="flex flex-col items-center justify-center py-12 gap-8">
            {/* Animated Scene */}
            <div className="relative w-32 h-32">
                {/* Floating Elements */}
                <div className="absolute top-0 left-1/2 -ml-4 animate-bounce delay-0">
                    <BrainCircuit className="text-sky-500 w-8 h-8" />
                </div>
                <div className="absolute bottom-4 left-0 animate-bounce delay-150">
                    <Calculator className="text-mint-500 text-[#10b981] w-8 h-8" />
                </div>
                <div className="absolute bottom-4 right-0 animate-bounce delay-300">
                    <Shapes className="text-pink-500 text-[#f472b6] w-8 h-8" />
                </div>

                {/* Central Pulse */}
                <div className="absolute inset-0 m-auto w-16 h-16 bg-gradient-to-tr from-sky-400 to-indigo-500 rounded-2xl animate-spin-slow shadow-lg shadow-sky-200 opacity-80 blur-sm"></div>
                <div className="absolute inset-0 m-auto w-16 h-16 bg-white rounded-2xl flex items-center justify-center z-10 shadow-sm border border-slate-100">
                    <span className="text-2xl">🌱</span>
                </div>
            </div>

            <div className="text-center space-y-2">
                <h3 className="text-lg font-bold text-slate-700">正在思考解题策略...</h3>
                <p className="text-slate-400 text-sm">AI老师正在为您准备详细的讲解视频</p>
            </div>
        </div>
    )
}
