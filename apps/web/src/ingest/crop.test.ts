import { describe, expect, it } from 'vitest'
import { cropRect, figureCropBox, worthCropping, type Box } from './crop'

describe('cropRect', () => {
    const W = 1600
    const H = 2200

    it('按比例换算成像素，并四周留余量', () => {
        const r = cropRect([0.1, 0.2, 0.9, 0.4], W, H)
        // 左右各留 1.5%、上下各留 2%
        expect(r.x).toBe(Math.round(0.085 * W))
        expect(r.y).toBe(Math.round(0.18 * H))
        expect(r.width).toBe(Math.round(0.915 * W) - r.x)
        expect(r.height).toBe(Math.round(0.42 * H) - r.y)
    })

    it('余量不会越出画布', () => {
        const r = cropRect([0, 0, 1, 1], W, H)
        expect(r).toEqual({ x: 0, y: 0, width: W, height: H })
    })

    it('贴边的框只往里侧留余量', () => {
        const r = cropRect([0, 0.9, 0.5, 1], W, H)
        expect(r.x).toBe(0)
        expect(r.y).toBe(Math.round(0.88 * H))
        expect(r.y + r.height).toBe(H)
    })

    it('退化成一条线时仍给出 1px，而不是让 canvas 抛错', () => {
        const r = cropRect([0.5, 0.5, 0.5, 0.5], 10, 10, 0, 0)
        expect(r.width).toBe(1)
        expect(r.height).toBe(1)
    })
})

describe('worthCropping', () => {
    /**
     * 它只管一件事：**裁出来的像素够不够看清**。
     * 框的形状是否离谱（窄条、细缝）由服务端的 normalizeBox 判，
     * 同一个判断不写两遍——写两遍就会有一天只改了一处。
     */
    it('1600px 页图上的正常单题值得裁', () => {
        expect(worthCropping(cropRect([0.08, 0.3, 0.95, 0.5], 1600, 2200))).toBe(true)
    })

    it('页图本身就很小时不裁，退回整页', () => {
        // 拍照上传的低分辨率图：裁出来只剩巴掌大，模型读不出小字
        expect(worthCropping(cropRect([0.1, 0.1, 0.9, 0.9], 200, 260))).toBe(false)
    })

    /**
     * 1600px 的页图上，凡是过得了服务端 normalizeBox（宽 ≥0.15、高 ≥0.03）的框，
     * 换算过来都是 288×154 以上，一律超过这个下限。
     * 也就是说这道闸门只对小页图起作用——写下来是为了以后有人改渲染宽度时知道会牵动什么。
     */
    it('1600px 页图上，最小的合法框也够大', () => {
        expect(worthCropping(cropRect([0.4, 0.5, 0.55, 0.53], 1600, 2200))).toBe(true)
    })
})

describe('figureCropBox', () => {
    const stemFigureBox: Box = [0.65, 0.08, 0.92, 0.2]
    const analysisFigureBox: Box = [0.2, 0.42, 0.5, 0.6]

    it('题干图与解析图各走各的', () => {
        expect(figureCropBox({ hasFigure: true, stemFigureBox, analysisFigureBox })).toEqual({
            stemFigureBox,
            analysisFigureBox,
        })
    })

    /**
     * 这条是安全关键的：解析里那张图往往就是解法本身
     * （「所求阴影部分面积等于下图中阴影部分面积」），做题时看见这道题就没了。
     */
    it('只有解析图时，题干图仍然是空的——绝不拿它顶替', () => {
        expect(figureCropBox({ hasFigure: true, analysisFigureBox })).toEqual({
            stemFigureBox: undefined,
            analysisFigureBox,
        })
    })

    it('版面说没有图就不给题干图', () => {
        expect(figureCropBox({ hasFigure: false, stemFigureBox }).stemFigureBox).toBeUndefined()
    })
})
