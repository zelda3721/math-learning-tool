/**
 * 共享视觉原语：统一各页面的页头 / 卡片 / 空态 / 加载态 / 错误态 / 按钮 / 徽章。
 * 全部零依赖，仅 Tailwind class 约定；页面只做结构替换，不改业务逻辑。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

/* ── PageHeader：统一页头（左标题+副标题，右动作区） ── */

interface PageHeaderProps {
    title: string
    subtitle?: string
    actions?: ReactNode
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
    return (
        <div className="flex flex-wrap items-end justify-between gap-3 px-1">
            <div>
                <h2 className="text-2xl font-bold text-slate-700">{title}</h2>
                {subtitle && <p className="text-sm text-slate-400 mt-0.5">{subtitle}</p>}
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
    )
}

/* ── Card：统一 soft-glass 卡片（内边距规范 p-6） ── */

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
    return <div className={`soft-glass p-6 ${className}`}>{children}</div>
}

/* ── 状态块：空态 / 加载态 / 错误态 ── */

interface EmptyStateProps {
    icon?: ReactNode
    title: string
    hint?: string
    action?: ReactNode
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
    return (
        <div className="soft-glass p-10 max-w-lg mx-auto text-center space-y-3">
            {icon != null && <p className="text-4xl">{icon}</p>}
            <h3 className="text-xl font-bold text-slate-700">{title}</h3>
            {hint && <p className="text-slate-500">{hint}</p>}
            {action && <div className="pt-1 flex justify-center gap-3">{action}</div>}
        </div>
    )
}

export function LoadingState({ text }: { text?: string }) {
    return <div className="text-center text-slate-400 py-16">{text ?? '正在加载……'}</div>
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className="soft-glass p-8 max-w-lg mx-auto text-center space-y-3">
            <h3 className="text-xl font-bold text-red-500">出了点小问题</h3>
            <p className="text-slate-500">{message}</p>
            {onRetry && (
                <div className="pt-1">
                    <Button onClick={onRetry}>重试</Button>
                </div>
            )}
        </div>
    )
}

/* ── Button：统一按钮（圆角胶囊） ── */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

const BUTTON_VARIANT_CLS: Record<ButtonVariant, string> = {
    primary:
        'bg-sky-500 text-white font-bold shadow-lg shadow-sky-200 hover:bg-sky-600 disabled:bg-slate-300 disabled:shadow-none',
    secondary:
        'bg-white border-2 border-slate-100 text-slate-600 font-semibold hover:border-sky-300 disabled:opacity-50',
    danger: 'bg-red-500 text-white font-bold shadow-lg shadow-red-200 hover:bg-red-600 disabled:bg-slate-300 disabled:shadow-none',
    ghost: 'text-slate-500 font-semibold hover:text-slate-700 disabled:opacity-40',
}

const BUTTON_SIZE_CLS: Record<ButtonSize, string> = {
    sm: 'px-4 py-1.5 text-sm',
    md: 'px-6 py-2.5',
    lg: 'px-10 py-4 text-xl',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant
    size?: ButtonSize
}

export function Button({ variant = 'primary', size = 'md', className = '', type, ...rest }: ButtonProps) {
    return (
        <button
            type={type ?? 'button'}
            className={`rounded-full transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANT_CLS[variant]} ${BUTTON_SIZE_CLS[size]} ${className}`}
            {...rest}
        />
    )
}

/* ── Badge：统一徽章 ── */

export type BadgeTone = 'sky' | 'emerald' | 'amber' | 'red' | 'slate'

const BADGE_TONE_CLS: Record<BadgeTone, string> = {
    sky: 'bg-sky-100 text-sky-600 border-sky-200',
    emerald: 'bg-emerald-100 text-emerald-600 border-emerald-200',
    amber: 'bg-amber-100 text-amber-700 border-amber-200',
    red: 'bg-red-100 text-red-600 border-red-200',
    slate: 'bg-slate-100 text-slate-500 border-slate-200',
}

export function Badge({ tone = 'slate', children }: { tone?: BadgeTone; children: ReactNode }) {
    return (
        <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${BADGE_TONE_CLS[tone]}`}
        >
            {children}
        </span>
    )
}
