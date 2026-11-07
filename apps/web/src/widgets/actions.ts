/**
 * 操作序列的两个纯函数：怎么追加、怎么重放。
 *
 * 组件只保存**操作序列**，状态每帧重放出来。这件小事值得单独成文件是因为
 * 它同时决定两件事：
 * 1. 画面（重放结果 = 孩子看到的）；
 * 2. 上报给服务端的 trace（服务端用同一套 replayWidget 再重放一遍）。
 * 两者共用同一段代码，才不会出现"我看到的"和"家长回看到的"不一样。
 */
import { applyWidgetAction, initialWidgetState } from '@mathtutor/widgets'
import type { WidgetAction, WidgetSpec, WidgetState } from '@mathtutor/widgets'

export interface ReplayResult {
  state: WidgetState
  /** 最后一步操作留下的那句话（被夹到边界时的解释）；没有就是 null */
  note: string | null
}

export function replayActions(spec: WidgetSpec, actions: WidgetAction[]): ReplayResult {
  let state: WidgetState = initialWidgetState(spec)
  let note: string | null = null
  for (const action of actions) {
    const result = applyWidgetAction(spec, state, action)
    state = result.state
    // 每一步都覆盖：note 说的是"刚才这一次发生了什么"，不是历史
    note = result.note ?? null
  }
  return { state, note }
}

/**
 * 追加一步操作，并合并连续同类操作。
 *
 * 为什么必须合并：滑杆是连续事件，拖一下就几十个 set。全存下来的话
 * 服务端的 trace 校验（上限 500 步）会直接把整条记录退回来。
 * 合并是安全的——同一 key 的连续 set 只留最后一个，连续 add 把增量相加，
 * 重放出来的最终状态完全一样（夹边界是单调的，先夹后加和先加后夹落在同一个值上）。
 * 中间步被吞掉不影响"发生了什么"，因为一个拖动本来就是一动作，不是五十个。
 */
export function appendAction(prev: WidgetAction[], action: WidgetAction): WidgetAction[] {
  const last = prev[prev.length - 1]
  if (last && last.op === 'set' && action.op === 'set' && last.key === action.key) {
    return [...prev.slice(0, -1), action]
  }
  if (last && last.op === 'add' && action.op === 'add' && last.key === action.key) {
    return [...prev.slice(0, -1), { op: 'add', key: action.key, delta: last.delta + action.delta }]
  }
  return [...prev, action]
}
