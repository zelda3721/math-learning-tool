import { describe, expect, it } from 'vitest'
import {
    balanceTilt,
    base10Layout,
    beamEnds,
    binsLayout,
    changeLayout,
    clockHandAngles,
    fractionSegments,
    gridLayout,
    numberLineGeometry,
    patternCars,
    patternUnit,
    plotPoint,
} from './kinds/layout'

/**
 * 几何层的测试：画面必须由状态算出来，算错了孩子看到的就是错的。
 *
 * 这里断言的都是"看得见的关系"，不是像素：落点在起点的哪边、天平往哪边沉、
 * 两张钱条的公共标尺是否一致。像素级留给人眼看图。
 */

describe('数轴跳跃', () => {
    it('往右跳：落点在起点右边，落点值 = 起点 + 跳数', () => {
        const g = numberLineGeometry({ start: 3, jump: 4, right: true, min: -10, max: 20 })
        expect(g.end).toBe(7)
        expect(g.endX).toBeGreaterThan(g.startX)
        expect(g.axisMin).toBe(-10)
        expect(g.axisMax).toBe(20)
    })

    it('往左跳：落点在起点左边（箭头要真的翻过去）', () => {
        const g = numberLineGeometry({ start: 3, jump: 4, right: false, min: -10, max: 20 })
        expect(g.end).toBe(-1)
        expect(g.endX).toBeLessThan(g.startX)
    })

    it('跳出范围时轴域跟着长出去，落点不会贴在边缘看不见', () => {
        const g = numberLineGeometry({ start: 20, jump: 10, right: true, min: -10, max: 20 })
        expect(g.end).toBe(30)
        expect(g.axisMax).toBe(30)
        expect(g.endX).toBeLessThanOrEqual(g.width)
    })

    it('刻度覆盖整个轴域，且不重复', () => {
        const g = numberLineGeometry({ start: 0, jump: 0, right: true, min: -3, max: 3, tick: 1 })
        expect(g.ticks.map((t) => t.value)).toEqual([-3, -2, -1, 0, 1, 2, 3])
        // 轴域小时每格都标数字，孩子数得出来
        expect(g.ticks.every((t) => t.label !== null)).toBe(true)
    })

    it('轴域大时只标 5 的倍数，免得数字糊成一片', () => {
        const g = numberLineGeometry({ start: 3, jump: 4, right: true, min: -10, max: 20 })
        const labeled = g.ticks.filter((t) => t.label !== null).map((t) => t.value)
        expect(labeled.length).toBeGreaterThan(0)
        expect(labeled.every((v) => v % 5 === 0)).toBe(true)
    })
})

describe('分数条', () => {
    it('切成 d 份，涂满前 n 份，份宽相等且不越界', () => {
        const segs = fractionSegments(4, 1, { width: 400, pad: 20, gap: 0 })
        expect(segs).toHaveLength(4)
        expect(segs.filter((s) => s.filled)).toHaveLength(1)
        expect(new Set(segs.map((s) => s.width)).size).toBe(1)
        const right = segs[3]!.x + segs[3]!.width
        expect(right).toBeCloseTo(380, 6)
    })

    it('分子大于分母时最多画满——不能画出"4 份里涂 5 份"', () => {
        const segs = fractionSegments(4, 9)
        expect(segs.filter((s) => s.filled)).toHaveLength(4)
    })

    it('分子为 0 时一份都不涂', () => {
        expect(fractionSegments(6, 0).every((s) => !s.filled)).toBe(true)
    })
})

describe('天平', () => {
    it('两边一样重就不歪', () => {
        expect(balanceTilt(5, 5)).toBe(0)
    })

    it('左边重往左沉（角度为正），右边重往右沉（角度为负）', () => {
        expect(balanceTilt(8, 3)).toBeGreaterThan(0)
        expect(balanceTilt(3, 8)).toBeLessThan(0)
    })

    it('差值越大越歪，但不会歪过最大角度', () => {
        expect(balanceTilt(4, 3)).toBeLessThan(balanceTilt(9, 1))
        expect(Math.abs(balanceTilt(20, 0))).toBeLessThanOrEqual(16)
        expect(Math.abs(balanceTilt(0, 20))).toBeLessThanOrEqual(16)
    })

    it('横梁两端：正角度时左端在屏幕上更低（看起来更重）', () => {
        const pivot = { x: 100, y: 50 }
        const flat = beamEnds(0, 60, pivot)
        expect(flat.left.y).toBeCloseTo(flat.right.y, 6)
        const tilted = beamEnds(10, 60, pivot)
        expect(tilted.left.y).toBeGreaterThan(tilted.right.y)
        // 托盘仍挂在横梁的同一侧，不会跑到对面去
        expect(tilted.left.x).toBeLessThan(pivot.x)
        expect(tilted.right.x).toBeGreaterThan(pivot.x)
    })
})

describe('钟面', () => {
    it('3:30 时分针指 6、时针在 3 和 4 中间', () => {
        const { hourAngle, minuteAngle } = clockHandAngles(3, 30)
        expect(minuteAngle).toBe(180)
        expect(hourAngle).toBe(105) // 3*30 + 30/60*30
    })

    it('分针走一圈，时针正好走一大格（30°）', () => {
        const at0 = clockHandAngles(5, 0).hourAngle
        const at6 = clockHandAngles(5, 5).hourAngle
        expect(at6 - at0).toBeCloseTo(2.5, 6) // 5 分钟 = 2.5°；12 个 5 分钟才凑满 30°
        expect(clockHandAngles(5, 59).hourAngle - at0).toBeCloseTo(29.5, 6)
    })

    it('24 点与 0 点是同一个位置', () => {
        expect(clockHandAngles(0, 0)).toEqual(clockHandAngles(24, 0))
        expect(clockHandAngles(12, 0).hourAngle).toBe(0)
    })
})

describe('面积格', () => {
    it('长 4 宽 3 就是 12 个格子，按行列铺开', () => {
        const g = gridLayout(4, 3, 30, 10)
        expect(g.count).toBe(12)
        expect(g.cells).toHaveLength(12)
        expect(new Set(g.cells.map((c) => `${c.x},${c.y}`)).size).toBe(12)
        expect(g.width).toBe(10 * 2 + 4 * 30)
    })
})

describe('十进制的捆与散', () => {
    it('13 个散块能捆 1 条，余 3 个', () => {
        const g = base10Layout(2, 13)
        expect(g.bundles).toBe(1)
        expect(g.leftover).toBe(3)
        expect(g.total).toBe(33)
    })

    it('不满十个就不捆', () => {
        expect(base10Layout(0, 9).bundles).toBe(0)
    })

    it('30 个散块能捆 3 条（这是上限，正好看满进位的全过程）', () => {
        expect(base10Layout(0, 30).bundles).toBe(3)
    })
})

describe('规律火车', () => {
    it('交替：一节一组里的两节不同色，第三节回到第一节的颜色', () => {
        expect(patternCars(true, 5)).toEqual(['warm', 'cool', 'warm', 'cool', 'warm'])
        expect(patternUnit(true)).toBe(2)
    })

    it('同色：所有车厢一个色，一组只有 1 节', () => {
        expect(patternCars(false, 4)).toEqual(['warm', 'warm', 'warm', 'warm'])
        expect(patternUnit(false)).toBe(1)
    })
})

describe('分堆', () => {
    it('只有当前筐里有东西，别的筐照旧在场（看得出"放进了哪一个"）', () => {
        const bins = binsLayout(['筐 A', '筐 B', '筐 C'], '筐 B', 5)
        expect(bins).toHaveLength(3)
        expect(bins.map((b) => b.count)).toEqual([0, 5, 0])
        expect(bins.filter((b) => b.active).map((b) => b.label)).toEqual(['筐 B'])
    })
})

describe('坐标点', () => {
    it('y 轴要翻转：(x, 0) 在底部、(x, maxY) 在顶部', () => {
        const bottom = plotPoint(3, 0, { maxX: 10, maxY: 10, unit: 20, pad: 30 })
        const top = plotPoint(3, 10, { maxX: 10, maxY: 10, unit: 20, pad: 30 })
        expect(bottom.py).toBeGreaterThan(top.py)
        expect(top.py).toBe(30)
        expect(bottom.py).toBe(30 + 10 * 20)
        // 横坐标不受影响
        expect(bottom.px).toBe(top.px)
    })

    it('(3,2) 与 (2,3) 是两个地方', () => {
        const a = plotPoint(3, 2, { maxX: 10, maxY: 10 })
        const b = plotPoint(2, 3, { maxX: 10, maxY: 10 })
        expect(a.px).not.toBe(b.px)
        expect(a.py).not.toBe(b.py)
    })

    it('坐标超出范围时夹在网格内，点不会画到图外面', () => {
        const g = plotPoint(99, 99, { maxX: 10, maxY: 10, unit: 20, pad: 30 })
        expect(g.px).toBe(30 + 10 * 20)
        expect(g.py).toBe(30)
    })
})

describe('找零', () => {
    it('付多了：找零 = 付 − 价，两根条共用同一把尺', () => {
        const g = changeLayout(8, 10, 50)
        expect(g.enough).toBe(true)
        expect(g.change).toBe(2)
        expect(g.short).toBe(0)
        // 价格条与付钱条的比例必须基于同一个 scaleMax，否则长度差是假的
        expect(g.priceRatio).toBeCloseTo(8 / 50, 6)
        expect(g.paidRatio).toBeCloseTo(10 / 50, 6)
        expect(g.changeRatio).toBeCloseTo(2 / 50, 6)
    })

    it('付少了：没有找零，只有缺口', () => {
        const g = changeLayout(8, 5, 50)
        expect(g.enough).toBe(false)
        expect(g.change).toBe(0)
        expect(g.short).toBe(3)
    })

    it('正好付清时差额为 0', () => {
        const g = changeLayout(8, 8, 50)
        expect(g.enough).toBe(true)
        expect(g.change).toBe(0)
        expect(g.changeRatio).toBe(0)
    })
})
