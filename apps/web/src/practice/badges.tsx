import type { MasteryBand, Slot } from './api'

/** 今日题组槽位徽章：队列 / 弱点 / 新题 / 挑战 */
const SLOT_META: Record<Slot, { label: string; cls: string }> = {
    queue: { label: '队列', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
    weak: { label: '弱点', cls: 'bg-rose-100 text-rose-600 border-rose-200' },
    new: { label: '新题', cls: 'bg-sky-100 text-sky-600 border-sky-200' },
    challenge: { label: '挑战', cls: 'bg-violet-100 text-violet-600 border-violet-200' },
}

export function SlotBadge({ slot }: { slot: Slot }) {
    const meta = SLOT_META[slot]
    return (
        <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${meta.cls}`}
        >
            {meta.label}
        </span>
    )
}

/** 掌握度亮度徽章：暗 → 微光 → 点亮 */
const BAND_META: Record<MasteryBand, { label: string; cls: string }> = {
    dim: { label: '暗', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
    glow: { label: '微光', cls: 'bg-amber-100 text-amber-600 border-amber-200' },
    lit: { label: '点亮', cls: 'bg-sky-100 text-sky-600 border-sky-200' },
}

export function BandBadge({ band }: { band: MasteryBand }) {
    const meta = BAND_META[band]
    return (
        <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${meta.cls}`}
        >
            {meta.label}
        </span>
    )
}
