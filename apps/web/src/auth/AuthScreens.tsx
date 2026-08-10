/**
 * 认证三态页面：首次初始化（创建家长账号）/ 登录 / 孩子自注册。
 * 未登录时整页渲染，与应用同一视觉语言：纸面 + 居中图版（.plate）+ .input-hero。
 * logo 锁定与顶栏一致（beam 方章 + Math/Tutor）。
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button, Field } from '../ui'
import { useAuth } from './AuthContext'

const LEVEL_OPTIONS: [string, string][] = [
    ['elementary_lower', '小学低年级'],
    ['elementary_upper', '小学高年级'],
    ['middle', '初中'],
    ['high', '高中'],
    ['advanced', '进阶'],
]

function AuthShell({ children }: { children: ReactNode }) {
    return (
        <div className="min-h-screen flex flex-col items-center justify-center px-4 py-10">
            <div className="flex items-center gap-2.5 mb-8">
                <div className="w-10 h-10 rounded-[10px] bg-beam flex items-center justify-center">
                    <span className="text-white font-bold text-xl leading-none">M</span>
                </div>
                <span className="font-bold text-2xl text-ink tracking-tight">
                    Math<span className="text-beam">Tutor</span>
                </span>
            </div>
            <div className="plate w-full max-w-md p-8">{children}</div>
        </div>
    )
}

function AuthHeading({ title, hint }: { title: string; hint: ReactNode }) {
    return (
        <div className="space-y-1.5 text-center pb-1">
            <h1 className="text-xl font-bold text-ink tracking-tight">{title}</h1>
            <p className="text-sm text-ink-faint leading-relaxed">{hint}</p>
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
            <form onSubmit={submit} className="space-y-5">
                <AuthHeading title="欢迎使用 MathTutor" hint="首次使用，先创建家长（管理员）账号" />
                <Field label="家长用户名">
                    <input
                        className="input-hero"
                        placeholder="用来登录的名字"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoFocus
                        required
                        maxLength={32}
                    />
                </Field>
                <Field label="密码" hint="至少 4 位">
                    <input
                        className="input-hero"
                        type="password"
                        placeholder="••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        minLength={4}
                        maxLength={64}
                    />
                </Field>
                {error && <p className="text-sm text-wrong">{error}</p>}
                <Button
                    type="submit"
                    size="lg"
                    className="w-full"
                    disabled={busy || !username.trim() || password.length < 4}
                >
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
            <form onSubmit={submit} className="space-y-5">
                <AuthHeading title="登录" hint="家长和孩子都从这里进入" />
                <Field label="用户名">
                    <input
                        className="input-hero"
                        placeholder="你的名字"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoFocus
                        required
                        maxLength={32}
                    />
                </Field>
                <Field label="密码">
                    <input
                        className="input-hero"
                        type="password"
                        placeholder="••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        maxLength={64}
                    />
                </Field>
                {error && <p className="text-sm text-wrong">{error}</p>}
                <Button
                    type="submit"
                    size="lg"
                    className="w-full"
                    disabled={busy || !username.trim() || !password}
                >
                    {busy ? '登录中……' : '登录'}
                </Button>
                <div className="text-center text-sm text-ink-faint pt-1 border-t border-rule mt-2">
                    {slotsLeft > 0 ? (
                        <button
                            type="button"
                            onClick={onRegister}
                            className="mt-4 font-semibold text-beam hover:text-beam-deep transition-colors"
                        >
                            我是新同学，注册一个账号（还剩 <span className="numeric">{slotsLeft}</span> 个名额）
                        </button>
                    ) : (
                        <span className="mt-4 inline-block">
                            注册名额已满（<span className="numeric">{bootstrap.childLimit}</span> 名）——请找家长管理账号
                        </span>
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
            <form onSubmit={submit} className="space-y-5">
                <AuthHeading
                    title="新同学注册"
                    hint={
                        <>
                            起个名字、设个密码，就可以开始点亮你的数学星图（还剩{' '}
                            <span className="numeric">{bootstrap.childLimit - bootstrap.childCount}</span> 个名额）
                        </>
                    }
                />
                <Field label="你的名字">
                    <input
                        className="input-hero"
                        placeholder="同学、老师都这么叫你"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoFocus
                        required
                        maxLength={32}
                    />
                </Field>
                <Field label="密码" hint="至少 4 位，自己记得住的">
                    <input
                        className="input-hero"
                        type="password"
                        placeholder="••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        minLength={4}
                        maxLength={64}
                    />
                </Field>
                <Field label="学段">
                    <select
                        className="input-hero"
                        value={level}
                        onChange={(e) => setLevel(e.target.value)}
                    >
                        {LEVEL_OPTIONS.map(([v, label]) => (
                            <option key={v} value={v}>{label}</option>
                        ))}
                    </select>
                </Field>
                {error && <p className="text-sm text-wrong">{error}</p>}
                <Button
                    type="submit"
                    size="lg"
                    className="w-full"
                    disabled={busy || !username.trim() || password.length < 4}
                >
                    {busy ? '注册中……' : '注册并开始'}
                </Button>
                <div className="text-center">
                    <button
                        type="button"
                        onClick={onBack}
                        className="text-sm text-ink-faint hover:text-ink transition-colors"
                    >
                        ← 返回登录
                    </button>
                </div>
            </form>
        </AuthShell>
    )
}
