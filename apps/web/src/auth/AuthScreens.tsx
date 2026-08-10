/**
 * 认证三态页面：首次初始化（创建家长账号）/ 登录 / 孩子自注册。
 * 未登录时整页渲染，与应用同一视觉语言（soft-glass 居中卡片）。
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../ui'
import { useAuth } from './AuthContext'

const LEVEL_OPTIONS: [string, string][] = [
    ['elementary_lower', '小学低年级'],
    ['elementary_upper', '小学高年级'],
    ['middle', '初中'],
    ['high', '高中'],
    ['advanced', '进阶'],
]

const inputCls =
    'w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-300'

function AuthShell({ children }: { children: ReactNode }) {
    return (
        <div className="min-h-screen flex flex-col items-center justify-center px-4 py-10">
            <div className="flex items-center gap-3 mb-8">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-400 to-indigo-500 flex items-center justify-center shadow-lg shadow-sky-200">
                    <span className="text-white font-bold text-xl">M</span>
                </div>
                <span className="font-bold text-2xl text-slate-700 tracking-tight">
                    Math<span className="text-sky-500">Tutor</span>
                </span>
            </div>
            <div className="soft-glass w-full max-w-md p-8">{children}</div>
        </div>
    )
}

export function SetupPage() {
    const { setupParent } = useAuth()
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const submit = async (e: FormEvent) => {
        e.preventDefault()
        setError(null)
        setBusy(true)
        try {
            await setupParent(username.trim(), password)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <AuthShell>
            <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1 text-center">
                    <h1 className="text-xl font-bold text-slate-700">欢迎使用 MathTutor</h1>
                    <p className="text-sm text-slate-400">首次使用，先创建家长（管理员）账号</p>
                </div>
                <input className={inputCls} placeholder="家长用户名" value={username}
                    onChange={(e) => setUsername(e.target.value)} autoFocus required maxLength={32} />
                <input className={inputCls} type="password" placeholder="密码（至少 4 位）" value={password}
                    onChange={(e) => setPassword(e.target.value)} required minLength={4} maxLength={64} />
                {error && <p className="text-sm text-red-500">{error}</p>}
                <Button type="submit" className="w-full" disabled={busy || !username.trim() || password.length < 4}>
                    {busy ? '创建中……' : '创建并进入'}
                </Button>
            </form>
        </AuthShell>
    )
}

export function AuthGate() {
    const [mode, setMode] = useState<'login' | 'register'>('login')
    return mode === 'login'
        ? <LoginPage onRegister={() => setMode('register')} />
        : <RegisterChildPage onBack={() => setMode('login')} />
}

function LoginPage({ onRegister }: { onRegister: () => void }) {
    const { login, bootstrap } = useAuth()
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const slotsLeft = bootstrap.childLimit - bootstrap.childCount

    const submit = async (e: FormEvent) => {
        e.preventDefault()
        setError(null)
        setBusy(true)
        try {
            await login(username.trim(), password)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <AuthShell>
            <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1 text-center">
                    <h1 className="text-xl font-bold text-slate-700">登录</h1>
                    <p className="text-sm text-slate-400">家长和孩子都从这里进入</p>
                </div>
                <input className={inputCls} placeholder="用户名（你的名字）" value={username}
                    onChange={(e) => setUsername(e.target.value)} autoFocus required maxLength={32} />
                <input className={inputCls} type="password" placeholder="密码" value={password}
                    onChange={(e) => setPassword(e.target.value)} required maxLength={64} />
                {error && <p className="text-sm text-red-500">{error}</p>}
                <Button type="submit" className="w-full" disabled={busy || !username.trim() || !password}>
                    {busy ? '登录中……' : '登录'}
                </Button>
                <div className="text-center text-sm text-slate-400 pt-1">
                    {slotsLeft > 0 ? (
                        <button type="button" onClick={onRegister} className="text-sky-500 hover:text-sky-600 font-medium">
                            我是新同学，注册一个账号（还剩 {slotsLeft} 个名额）
                        </button>
                    ) : (
                        <span>注册名额已满（{bootstrap.childLimit} 名）——请找家长管理账号</span>
                    )}
                </div>
            </form>
        </AuthShell>
    )
}

function RegisterChildPage({ onBack }: { onBack: () => void }) {
    const { registerChild, bootstrap } = useAuth()
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [level, setLevel] = useState('elementary_upper')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const submit = async (e: FormEvent) => {
        e.preventDefault()
        setError(null)
        setBusy(true)
        try {
            await registerChild(username.trim(), password, level)
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <AuthShell>
            <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1 text-center">
                    <h1 className="text-xl font-bold text-slate-700">新同学注册</h1>
                    <p className="text-sm text-slate-400">
                        起个名字、设个密码，就可以开始点亮你的数学星图（还剩{' '}
                        {bootstrap.childLimit - bootstrap.childCount} 个名额）
                    </p>
                </div>
                <input className={inputCls} placeholder="你的名字" value={username}
                    onChange={(e) => setUsername(e.target.value)} autoFocus required maxLength={32} />
                <input className={inputCls} type="password" placeholder="密码（至少 4 位，自己记得住的）" value={password}
                    onChange={(e) => setPassword(e.target.value)} required minLength={4} maxLength={64} />
                <select className={inputCls} value={level} onChange={(e) => setLevel(e.target.value)}>
                    {LEVEL_OPTIONS.map(([v, label]) => (
                        <option key={v} value={v}>{label}</option>
                    ))}
                </select>
                {error && <p className="text-sm text-red-500">{error}</p>}
                <Button type="submit" className="w-full" disabled={busy || !username.trim() || password.length < 4}>
                    {busy ? '注册中……' : '注册并开始'}
                </Button>
                <div className="text-center">
                    <button type="button" onClick={onBack} className="text-sm text-slate-400 hover:text-slate-600">
                        ← 返回登录
                    </button>
                </div>
            </form>
        </AuthShell>
    )
}
