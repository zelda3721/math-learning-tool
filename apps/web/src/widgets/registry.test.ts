import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { allWidgets, applyWidgetAction, initialWidgetState, type WidgetState } from '@mathtutor/widgets'
import { WIDGET_VIEWS } from './kinds'

/**
 * 渲染器覆盖测试：每个 kind 都要能画，而且画出来不能有 NaN。
 *
 * 为什么值得测：SVG 的坐标属性一旦是 NaN，浏览器**不会报错**，只会不画——
 * 屏幕上就是一块空白，界面上看不出任何痕迹。这类失败靠人点很难发现，
 * 靠一行断言很容易。
 */
const specs = allWidgets()

/** 渲染一次，顺便把 viewBox 与所有坐标属性掏出来 */
function render(spec: (typeof specs)[number], state: WidgetState): string {
    return renderToStaticMarkup(
        createElement(WIDGET_VIEWS[spec.kind], { spec, state }),
    )
}

/** 坐标画到 viewBox 外面的地方：SVG 不会报错，只会默默裁掉，所以只能自己查 */
function outOfBounds(html: string, margin = 3): string[] {
    const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(html)
    if (!box) return ['没有 viewBox']
    const w = Number(box[1])
    const h = Number(box[2])
    const bad: string[] = []
    for (const m of html.matchAll(/\b(cx|cy|x|y|x1|x2|y1|y2)="(-?[\d.]+)"/g)) {
        const key = m[1]!
        const value = Number(m[2])
        const limit = key === 'cx' || key === 'x' || key === 'x1' || key === 'x2' ? w : h
        if (value < -margin || value > limit + margin) bad.push(`${key}=${value}（上限 ${limit}）`)
    }
    for (const m of html.matchAll(/points="([^"]+)"/g)) {
        for (const pair of m[1]!.split(/\s+/)) {
            const [px, py] = pair.split(',').map(Number)
            if (px === undefined || py === undefined || Number.isNaN(px) || Number.isNaN(py)) continue
            if (px < -margin || px > w + margin || py < -margin || py > h + margin) bad.push(`点 (${px},${py})`)
        }
    }
    return bad
}

describe('十个组件都有渲染器', () => {
    it('渲染器表覆盖 catalog 里的每一个 kind（不漏、不多）', () => {
        expect(Object.keys(WIDGET_VIEWS).sort()).toEqual(specs.map((s) => s.kind).sort())
    })

    it('初始状态能画出来，且不含 NaN', () => {
        for (const spec of specs) {
            const html = render(spec, initialWidgetState(spec))
            expect(html, `${spec.kind} 应该画出一张 SVG`).toContain('<svg')
            expect(html, `${spec.kind} 的初始状态不应出现 NaN`).not.toContain('NaN')
        }
    })

    it('所有东西都画在 viewBox 里（画出去的部分会被默默裁掉，界面上看不出来）', () => {
        for (const spec of specs) {
            const states: [string, WidgetState][] = [['初始', initialWidgetState(spec)]]
            // 每个 step 控件推到最大 / 最小：边界状态最容易把元素挤出画布
            let maxed: WidgetState = initialWidgetState(spec)
            let mined: WidgetState = initialWidgetState(spec)
            for (const control of spec.controls) {
                if (control.type !== 'step') continue
                maxed = applyWidgetAction(spec, maxed, { op: 'set', key: control.key, value: control.max }).state
                mined = applyWidgetAction(spec, mined, { op: 'set', key: control.key, value: control.min }).state
            }
            states.push(['最大', maxed], ['最小', mined])
            for (const [label, state] of states) {
                expect(outOfBounds(render(spec, state)), `${spec.kind} ${label}时画出了画布`).toEqual([])
            }
        }
    })

    it('把所有控件推到边界，状态照样画得出来（边界由 reduce 夹住，画面不该崩）', () => {
        for (const spec of specs) {
            let state: WidgetState = initialWidgetState(spec)
            for (const control of spec.controls) {
                if (control.type === 'step') {
                    state = applyWidgetAction(spec, state, { op: 'set', key: control.key, value: control.max }).state
                } else if (control.type === 'pick') {
                    state = applyWidgetAction(spec, state, {
                        op: 'pick',
                        key: control.key,
                        value: control.options[control.options.length - 1]!,
                    }).state
                } else {
                    state = applyWidgetAction(spec, state, { op: 'toggle', key: control.key }).state
                }
            }
            const html = renderToStaticMarkup(createElement(WIDGET_VIEWS[spec.kind], { spec, state }))
            expect(html, `${spec.kind} 推到边界后仍应画得出`).toContain('<svg')
            expect(html, `${spec.kind} 推到边界后不应出现 NaN`).not.toContain('NaN')
        }
    })

    it('每个控件的 key 在初始状态里都有值（否则滑杆会停在一个不存在的位置）', () => {
        for (const spec of specs) {
            const state = initialWidgetState(spec)
            for (const control of spec.controls) {
                expect(state, `${spec.kind} 缺 ${control.key}`).toHaveProperty(control.key)
            }
        }
    })
})
