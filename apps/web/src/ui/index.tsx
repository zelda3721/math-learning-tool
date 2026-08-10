/**
 * 共享视觉原语 ——「星图纸」设计系统的组件层。
 * 页面只用这些词汇，不再手写空态/按钮/徽章样式。
 * 色彩纪律：金色（lit）只表示"学会了"，交互一律用 beam 靛蓝。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export { MathText } from './MathText'

/* ── PageHeader：每页统一页头 ── */

interface PageHeaderProps {
    title: string
    subtitle?: string
    actions?: ReactNode
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
    return (
        <div className="flex flex-wrap items-end justify-between gap-3 pb-4 mb-6 border-b border-rule">
            <div className="min-w-0">
                <h2 className="text-2xl font-bold text-ink tracking-tight">{title}</h2>
                {subtitle && <p className="text-sm text-ink-faint mt-1">{subtitle}</p>}
            </div>
            {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
    )
}

/* ── Card：图版 ── */

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
    return <div className={`plate p-6 ${className}`}>{children}</div>
}

/* ── 状态块 ── */

interface EmptyStateProps {
    icon?: ReactNode
    title: string
    hint?: string
    action?: ReactNode
}

export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
    return (
        <div className="plate px-8 py-12 max-w-lg mx-auto text-center">
            {icon != null && <p className="text-3xl mb-3 opacity-70">{icon}</p>}
            <h3 className="text-lg font-semibold text-ink">{title}</h3>
            {hint && <p className="text-ink-faint text-sm mt-1.5 leading-relaxed">{hint}</p>}
            {action && <div className="pt-5 flex justify-center gap-3">{action}</div>}
        </div>
    )
}

export function LoadingState({ text }: { text?: string }) {
    return (
        <div className="flex items-center justify-center gap-2.5 py-16 text-ink-faint text-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-beam animate-pulse" />
            {text ?? '正在加载'}
        </div>
    )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className="plate px-8 py-10 max-w-lg mx-auto text-center">
            <h3 className="text-lg font-semibold text-wrong">没能完成</h3>
            <p className="text-ink-soft text-sm mt-2 leading-relaxed">{message}</p>
            {onRetry && (
                <div className="pt-5">
                    <Button onClick={onRetry}>重试</Button>
                </div>
            )}
        </div>
    )
}

/* ── Button ── */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANT: Record<ButtonVariant, string> = {
    primary: 'bg-beam text-white font-semibold hover:bg-beam-deep disabled:bg-rule disabled:text-ink-faint',
    secondary:
        'bg-plate text-ink-soft font-medium border border-rule hover:border-beam hover:text-beam disabled:opacity-50',
    danger: 'bg-wrong text-white font-semibold hover:brightness-95 disabled:bg-rule disabled:text-ink-faint',
    ghost: 'text-ink-faint font-medium hover:text-ink disabled:opacity-40',
}

const SIZE: Record<ButtonSize, string> = {
    sm: 'px-3.5 py-1.5 text-sm',
    md: 'px-5 py-2.5 text-[15px]',
    lg: 'px-8 py-3.5 text-lg',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant
    size?: ButtonSize
}

export function Button({ variant = 'primary', size = 'md', className = '', type, ...rest }: ButtonProps) {
    return (
        <button
            type={type ?? 'button'}
            className={`rounded-[10px] transition-colors disabled:cursor-not-allowed ${VARIANT[variant]} ${SIZE[size]} ${className}`}
            {...rest}
        />
    )
}

/* ── Badge ──
   tone 与语义绑定：lit=学会了、right/wrong=判定、beam=当前、slate=中性 */

export type BadgeTone = 'sky' | 'beam' | 'emerald' | 'correct' | 'amber' | 'lit' | 'red' | 'wrong' | 'slate'

const TONE: Record<BadgeTone, string> = {
    beam: 'bg-beam-wash text-beam border-beam/20',
    sky: 'bg-beam-wash text-beam border-beam/20',
    lit: 'bg-lit-wash text-lit border-lit/25',
    amber: 'bg-lit-wash text-lit border-lit/25',
    correct: 'bg-correct-wash text-correct border-correct/20',
    emerald: 'bg-correct-wash text-correct border-correct/20',
    wrong: 'bg-wrong-wash text-wrong border-wrong/20',
    red: 'bg-wrong-wash text-wrong border-wrong/20',
    slate: 'bg-paper text-ink-faint border-rule',
}

export function Badge({ tone = 'slate', children }: { tone?: BadgeTone; children: ReactNode }) {
    return (
        <span
            className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${TONE[tone]}`}
        >
            {children}
        </span>
    )
}

/* ── Lightline：签名元素。进度即"点亮"，金色只在这里 ── */

export function Lightline({ value, max = 1 }: { value: number; max?: number }) {
    const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0))
    return (
        <div className="lightline" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
            <i style={{ width: `${pct}%` }} />
        </div>
    )
}

/* ── Field：表单行（标签 + 控件），统一表单节奏 ── */

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <label className="block space-y-1.5">
            <span className="eyebrow block">{label}</span>
            {children}
            {hint && <span className="block text-xs text-ink-faint">{hint}</span>}
        </label>
    )
}
