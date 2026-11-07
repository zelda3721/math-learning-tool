import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { summarizeWidget } from '@mathtutor/widgets'
import type { WidgetAction, WidgetControl, WidgetSpec, WidgetState } from '@mathtutor/widgets'
import { Button } from '../ui'
import { WIDGET_VIEWS } from './kinds'
import { appendAction, replayActions } from './actions'

/** 一次探索的痕迹：操作序列 + 最终状态（服务端会重放操作、以重放结果为准） */
export interface WidgetTraceDraft {
  actions: WidgetAction[]
  finalState: WidgetState
}

interface Props {
  spec: WidgetSpec
  onDone: (trace: WidgetTraceDraft) => void
}

/**
 * 动手组件的宿主：出控件、收操作、画画面、收尾。
 *
 * **边界不在这里算**。所有"能拖到几""涂几份""满十要捆"的规则都在
 * @mathtutor/widgets 的 applyWidgetAction 里，这里只把返回的新状态与那句
 * note（比如"只分成 4 份，最多涂 4 份"）原样呈上。
 * 为什么这么苛刻：状态机写进 React 就会分叉成两套规则，截图和日志、家长回看
 * 的重放结果迟早对不上；而且孩子被夹住时该看到一句解释，不该看到数字悄悄变了。
 */
export function WidgetHost({ spec, onDone }: Props) {
  /*
   * 唯一的状态就是**操作序列**，画面上的 state 每帧由它重放出来。
   *
   * 为什么不用 useState<WidgetState>：
   * 1. 服务端收到 trace 后会用 replayWidget 重放同一串操作。这里也用重放，
   *    两边就是同一套算法、同一份输入，"客户端看到的"和"家长回看到的"不可能不一致。
   * 2. 滑杆是连续事件，快速连点下若各存一份 state，后一次会把前一次盖掉；
   *    而追加操作没有这个问题——先发生的先重放。
   * 代价是每次渲染重放一遍（最多几百步纯函数），在动手组件这个量级上可以忽略。
   */
  const [actions, setActions] = useState<WidgetAction[]>([])
  const [kind, setKind] = useState(spec.kind)

  // 换了一个组件（kind 变了）就从头开始：上一台机器的操作对这台没有意义。
  // 父组件正常会用 key 重新挂载；这里是兜底，防止被复用成"串味"的组件。
  if (kind !== spec.kind) {
    setKind(spec.kind)
    setActions([])
  }

  const { state, note } = useMemo(() => replayActions(spec, actions), [spec, actions])

  const dispatch = useCallback((action: WidgetAction) => {
    setActions((prev) => appendAction(prev, action))
  }, [])

  const View = WIDGET_VIEWS[spec.kind] ?? null

  return (
    /* data-testid：e2e 要在这台组件里找画面与滑杆，而不是在满页图标里猜第一个 svg */
    <div className="space-y-4" data-testid="widget-host">
      {/* 画面：由 state 算出来，不是示意图 */}
      <div className="rounded-[12px] border border-rule bg-paper p-3 md:p-4">
        {View ? (
          <View spec={spec} state={state} />
        ) : (
          <p className="text-sm text-ink-faint py-8 text-center">这个组件暂时画不出来，但下面的数字仍然可以调。</p>
        )}
      </div>

      {/* 控件：一律按 spec.controls 出，前端不写死任何一个 key */}
      <div className="space-y-3">
        {spec.controls.map((control) => (
          <ControlRow key={control.key} control={control} state={state} onChange={dispatch} />
        ))}
      </div>

      {/* 被夹到边界时的那句话：一定要显示，否则孩子以为自己拖错了 */}
      {note && (
        <p role="status" className="rounded-[10px] border border-beam/25 bg-beam-wash px-3 py-2 text-sm text-beam">
          {note}
        </p>
      )}

      <div className="rounded-[10px] border border-rule bg-paper px-4 py-3 space-y-1">
        <p className="text-sm font-semibold text-ink">{summarizeWidget(spec, state)}</p>
        <p className="text-xs text-ink-soft leading-relaxed">{spec.insight}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => onDone({ actions, finalState: state })}>我看明白了，做题</Button>
        <Button variant="ghost" size="sm" onClick={() => dispatch({ op: 'reset' })}>
          重来
        </Button>
      </div>
    </div>
  )
}

/** 三种控件：step 出滑杆 + 数字、pick 出分段按钮、toggle 出开关 */
function ControlRow({
  control,
  state,
  onChange,
}: {
  control: WidgetControl
  state: WidgetState
  onChange: (action: WidgetAction) => void
}) {
  if (control.type === 'step') {
    const step = control.step ?? 1
    const raw = Number(state[control.key])
    const value = Number.isFinite(raw) ? raw : control.min

    return (
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="eyebrow">{control.label}</span>
          <span className="numeric text-sm font-semibold text-beam">
            {value}
            {control.unit ?? ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StepButton label={`${control.label}减少`} onClick={() => onChange({ op: 'add', key: control.key, delta: -step })}>
            −
          </StepButton>
          <input
            type="range"
            aria-label={control.label}
            min={control.min}
            max={control.max}
            step={step}
            value={value}
            onChange={(e) => onChange({ op: 'set', key: control.key, value: Number(e.target.value) })}
            className="flex-1 min-w-0"
            style={{ accentColor: 'var(--color-beam)' }}
          />
          <StepButton label={`${control.label}增加`} onClick={() => onChange({ op: 'add', key: control.key, delta: step })}>
            +
          </StepButton>
        </div>
      </div>
    )
  }

  if (control.type === 'pick') {
    const current = String(state[control.key] ?? '')
    return (
      <div className="space-y-1.5">
        <span className="eyebrow block">{control.label}</span>
        <div className="flex flex-wrap gap-2">
          {control.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={current === option ? 'primary' : 'secondary'}
              aria-pressed={current === option}
              onClick={() => onChange({ op: 'pick', key: control.key, value: option })}
            >
              {option}
            </Button>
          ))}
        </div>
      </div>
    )
  }

  const on = Boolean(state[control.key])
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange({ op: 'toggle', key: control.key })}
      className="flex items-center gap-3 text-left"
    >
      <span
        className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
        style={{ background: on ? 'var(--color-beam)' : 'var(--color-rule)' }}
      >
        <span
          className="inline-block rounded-full bg-white transition-transform"
          style={{ height: 18, width: 18, transform: `translateX(${on ? 23 : 3}px)` }}
        />
      </span>
      <span className="text-sm text-ink">{control.label}</span>
    </button>
  )
}

function StepButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="shrink-0 rounded-[8px] border border-rule bg-plate px-2.5 py-1 text-sm text-ink-soft hover:border-beam hover:text-beam"
    >
      {children}
    </button>
  )
}
