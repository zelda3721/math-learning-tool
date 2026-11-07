import { describe, expect, it } from 'vitest'
import { applyWidgetAction, initialWidgetState, widgetOf, type WidgetAction } from '@mathtutor/widgets'
import { appendAction, replayActions } from './actions'

/**
 * 操作序列的测试：重放结果必须等于一步步点出来的结果，
 * 合并后的序列也必须走到同一个地方——否则孩子看到的和上报的会分叉。
 */

const fraction = widgetOf('fraction_bar')!
const numberLine = widgetOf('number_line_jump')!

describe('replayActions', () => {
    it('与逐步 applyWidgetAction 的结果一致', () => {
        const actions: WidgetAction[] = [
            { op: 'set', key: 'denominator', value: 6 },
            { op: 'set', key: 'numerator', value: 5 },
        ]
        let state = initialWidgetState(fraction)
        for (const action of actions) state = applyWidgetAction(fraction, state, action).state
        expect(replayActions(fraction, actions).state).toEqual(state)
        expect(replayActions(fraction, actions).state).toMatchObject({ denominator: 6, numerator: 5 })
    })

    it('note 只留最后一步的：被夹住时的那句解释不会提前消失、也不会堆成历史', () => {
        const actions: WidgetAction[] = [
            { op: 'set', key: 'denominator', value: 4 },
            { op: 'set', key: 'numerator', value: 9 },
        ]
        const result = replayActions(fraction, actions)
        expect(result.state.numerator).toBe(4)
        expect(result.note).toBe('只分成 4 份，最多涂 4 份')
    })

    it('reset 也是普通一步：reset 之后等于初始状态', () => {
        const actions: WidgetAction[] = [
            { op: 'set', key: 'denominator', value: 8 },
            { op: 'reset' },
        ]
        expect(replayActions(fraction, actions).state).toEqual(initialWidgetState(fraction))
    })

    it('空序列就是初始状态', () => {
        expect(replayActions(numberLine, [])).toEqual({ state: initialWidgetState(numberLine), note: null })
    })
})

describe('appendAction', () => {
    it('同一 key 的连续 set 只留最后一个（滑杆拖动别塞满 500 步上限）', () => {
        let actions: WidgetAction[] = []
        for (const value of [1, 2, 3, 4, 5]) {
            actions = appendAction(actions, { op: 'set', key: 'start', value })
        }
        expect(actions).toEqual([{ op: 'set', key: 'start', value: 5 }])
    })

    it('不同 key 的 set 不合并（那是两个动作）', () => {
        let actions = appendAction([], { op: 'set', key: 'start', value: 2 } as WidgetAction)
        actions = appendAction(actions, { op: 'set', key: 'jump', value: 3 })
        expect(actions).toHaveLength(2)
    })

    it('连续 add 合成一次，重放结果不变', () => {
        let actions: WidgetAction[] = []
        actions = appendAction(actions, { op: 'add', key: 'jump', delta: 1 })
        actions = appendAction(actions, { op: 'add', key: 'jump', delta: 1 })
        actions = appendAction(actions, { op: 'add', key: 'jump', delta: 1 })
        expect(actions).toEqual([{ op: 'add', key: 'jump', delta: 3 }])
        expect(replayActions(numberLine, actions).state).toEqual(
            replayActions(numberLine, [
                { op: 'add', key: 'jump', delta: 1 },
                { op: 'add', key: 'jump', delta: 1 },
                { op: 'add', key: 'jump', delta: 1 },
            ]).state,
        )
    })

    it('合并后仍然遵守边界：连加到超上限，落点是被夹过的值', () => {
        // 起始 jump = 4，上限 10：加 20 次 1 应当停在 10
        let actions: WidgetAction[] = []
        for (let i = 0; i < 20; i += 1) actions = appendAction(actions, { op: 'add', key: 'jump', delta: 1 })
        const merged = replayActions(numberLine, actions)
        const sequential = replayActions(
            numberLine,
            Array.from({ length: 20 }, () => ({ op: 'add', key: 'jump', delta: 1 }) as WidgetAction),
        )
        expect(merged.state.jump).toBe(10)
        expect(merged.state).toEqual(sequential.state)
    })

    it('toggle 之类不带 key 比较的动作照旧追加', () => {
        let actions = appendAction([], { op: 'toggle', key: 'mode' })
        actions = appendAction(actions, { op: 'reset' })
        expect(actions).toEqual([{ op: 'toggle', key: 'mode' }, { op: 'reset' }])
    })
})
