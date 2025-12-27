import { Menu, Settings, Bell } from 'lucide-react'

export function Header() {
    return (
        <header className="sticky top-4 z-50 px-4 mb-4">
            <div className="soft-glass mx-auto max-w-5xl px-6 py-3 flex items-center justify-between">
                {/* Logo Area */}
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-400 to-indigo-500 flex items-center justify-center shadow-lg shadow-sky-200">
                        <span className="text-white font-bold text-lg">M</span>
                    </div>
                    <span className="font-bold text-lg text-slate-700 tracking-tight">
                        Math<span className="text-sky-500">Tutor</span>
                    </span>
                </div>

                {/* Nav Links (Hidden on small screens) */}
                <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-500">
                    <a href="#" className="text-sky-600">首页</a>
                    <a href="#" className="hover:text-slate-800 transition-colors">历史记录</a>
                    <a href="#" className="hover:text-slate-800 transition-colors">错题本</a>
                    <a href="#" className="hover:text-slate-800 transition-colors">我的成就</a>
                </nav>

                {/* Actions */}
                <div className="flex items-center gap-3">
                    <button className="p-2 text-slate-400 hover:text-sky-500 hover:bg-sky-50 rounded-full transition-all">
                        <Bell size={20} />
                    </button>
                    <button className="p-2 text-slate-400 hover:text-sky-500 hover:bg-sky-50 rounded-full transition-all">
                        <Settings size={20} />
                    </button>
                    <div className="w-8 h-8 rounded-full bg-slate-200 border-2 border-white shadow-sm overflow-hidden ml-2">
                        <img
                            src="https://api.dicebear.com/7.x/notionists/svg?seed=Felix"
                            alt="User"
                            className="w-full h-full object-cover"
                        />
                    </div>
                </div>
            </div>
        </header>
    )
}
