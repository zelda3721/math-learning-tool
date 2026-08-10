import type { MasteryBand, Slot } from './api'
import { Badge, type BadgeTone } from '../ui'

/** 今日题组槽位徽章：复习 / 探针 / 弱点 / 新题 / 挑战
 *  语义色纪律：金色只留给「学会了」，槽位是中性分类，弱点用 wrong。 */
const SLOT_META: Record<Slot, { label: string; tone: BadgeTone }> = {
    review: { label: '复习', tone: 'slate' },
    queue: { label: '探针', tone: 'beam' },
    weak: { label: '弱点', tone: 'wrong' },
    new: { label: '新题', tone: 'beam' },
    challenge: { label: '挑战', tone: 'slate' },
    asked: { label: '我问的', tone: 'beam' },
}

export function SlotBadge({ slot }: { slot: Slot }) {
    const meta = SLOT_META[slot]
    return <Badge tone={meta.tone}>{meta.label}</Badge>
}

/** 掌握度亮度徽章：暗 → 微光 → 点亮。
 *  这里是「点亮」语义本身，所以是唯一允许用金色系的徽章：
 *  暗=中性、微光=glow（半亮的金）、点亮=lit（满亮的金）。 */
const BAND_META: Record<MasteryBand, { label: string; cls: string }> = {
    dim: { label: '暗', cls: 'bg-paper text-ink-faint border-rule' },
    glow: { label: '微光', cls: 'bg-lit-wash text-glow border-glow/35' },
    lit: { label: '点亮', cls: 'bg-lit-wash text-lit border-lit/25' },
}

export function BandBadge({ band }: { band: MasteryBand }) {
    const meta = BAND_META[band]
    return (
        <span
            className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${meta.cls}`}
        >
            {meta.label}
        </span>
    )
}
