import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from 'react'

export interface AuthUser {
    id: string
    role: 'parent' | 'child'
    username: string
    learnerId?: string
    /** 孩子账号的年级（注册时选择，state 会带回；家长无此字段） */
    level?: string
}

export interface AuthBootstrap {
    parentExists: boolean
    childCount: number
    childLimit: number
}

export type AuthStatus = 'loading' | 'setup' | 'anon' | 'authed'

interface AuthStateResponse {
    parentExists: boolean
    childCount: number
    childLimit: number
    user: AuthUser | null
}

interface AuthContextValue {
    status: AuthStatus
    user: AuthUser | null
    bootstrap: AuthBootstrap
    login: (username: string, password: string) => Promise<void>
    logout: () => Promise<void>
    refresh: () => Promise<void>
    setupParent: (username: string, password: string) => Promise<void>
    registerChild: (username: string, password: string, level: string) => Promise<void>
    /** 任意页面的 fetch 收到 401 时调用（或经由 notifyUnauthorized 的 window 事件），整体回到登录态 */
    handleUnauthorized: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** 全局 401 广播事件名：非 React 代码（services 层等）可直接 dispatch */
export const UNAUTHORIZED_EVENT = 'mathtutor:unauthorized'

/** 在任何 fetch 层收到 401 时调用，通知 AuthProvider 回到登录态 */
export function notifyUnauthorized() {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}

/** fetch 的薄包装：401 时自动广播回登录态，其余行为与 fetch 一致 */
export async function authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const res = await fetch(input, init)
    if (res.status === 401) notifyUnauthorized()
    return res
}

async function readError(res: Response, fallback: string): Promise<string> {
    try {
        const body = (await res.json()) as { error?: string }
        return body.error || fallback
    } catch {
        return fallback
    }
}

const DEFAULT_BOOTSTRAP: AuthBootstrap = { parentExists: true, childCount: 0, childLimit: 5 }

export function AuthProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<AuthStatus>('loading')
    const [user, setUser] = useState<AuthUser | null>(null)
    const [bootstrap, setBootstrap] = useState<AuthBootstrap>(DEFAULT_BOOTSTRAP)

    const refresh = useCallback(async () => {
        const res = await fetch('/api/v1/auth/state')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as AuthStateResponse
        setBootstrap({
            parentExists: body.parentExists,
            childCount: body.childCount,
            childLimit: body.childLimit,
        })
        setUser(body.user)
        setStatus(body.user ? 'authed' : body.parentExists ? 'anon' : 'setup')
    }, [])

    useEffect(() => {
        void refresh().catch(() => {
            // state 接口不可达：退回匿名登录态，用户可重试登录
            setStatus('anon')
        })
    }, [refresh])

    const handleUnauthorized = useCallback(() => {
        setUser(null)
        setStatus((s) => (s === 'loading' || s === 'setup' ? s : 'anon'))
    }, [])

    useEffect(() => {
        window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
        return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
    }, [handleUnauthorized])

    // 全局 401 拦截：任何页面的 /api fetch 过期即回登录态（免逐页接线）
    useEffect(() => {
        const original = window.fetch
        window.fetch = async (...args: Parameters<typeof fetch>) => {
            const res = await original(...args)
            const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url
            if (res.status === 401 && url.includes('/api/') && !url.includes('/api/v1/auth/')) {
                notifyUnauthorized()
            }
            return res
        }
        return () => {
            window.fetch = original
        }
    }, [])

    const login = useCallback(
        async (username: string, password: string) => {
            const res = await fetch('/api/v1/auth/login', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username, password }),
            })
            if (!res.ok) throw new Error(await readError(res, '登录失败，请检查用户名和密码'))
            await refresh()
        },
        [refresh]
    )

    const logout = useCallback(async () => {
        try {
            await fetch('/api/v1/auth/logout', { method: 'POST' })
        } finally {
            setUser(null)
            setStatus('anon')
            void refresh().catch(() => undefined)
        }
    }, [refresh])

    const setupParent = useCallback(
        async (username: string, password: string) => {
            const res = await fetch('/api/v1/auth/setup-parent', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username, password }),
            })
            if (!res.ok) throw new Error(await readError(res, '创建家长账号失败'))
            await refresh()
        },
        [refresh]
    )

    const registerChild = useCallback(
        async (username: string, password: string, level: string) => {
            const res = await fetch('/api/v1/auth/register-child', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username, password, level }),
            })
            if (!res.ok) throw new Error(await readError(res, '注册失败，请稍后再试'))
            await refresh()
        },
        [refresh]
    )

    return (
        <AuthContext.Provider
            value={{
                status,
                user,
                bootstrap,
                login,
                logout,
                refresh,
                setupParent,
                registerChild,
                handleUnauthorized,
            }}
        >
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth(): AuthContextValue {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within AuthProvider')
    return ctx
}
