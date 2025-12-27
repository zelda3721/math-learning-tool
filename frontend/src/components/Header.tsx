export function Header() {
    return (
        <header className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl border-b border-white/10 sticky top-0 z-50">
            <div className="container mx-auto px-4 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                        <span className="text-xl">📐</span>
                    </div>
                    <div>
                        <h1 className="text-xl font-bold gradient-text">Math Tutor</h1>
                        <p className="text-xs text-zinc-500">AI-Powered Visual Learning</p>
                    </div>
                </div>

                <nav className="flex items-center gap-4">
                    <a href="#" className="text-sm text-zinc-400 hover:text-white transition-colors">
                        帮助
                    </a>
                </nav>
            </div>
        </header>
    )
}
