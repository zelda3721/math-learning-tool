import { describe, expect, it } from 'vitest'
import { figurePadBox, pickPhotoItem, textLineAxis, type PhotoLayoutItem } from './photoProblem'

const item = (partial: Partial<PhotoLayoutItem> & { index: number }): PhotoLayoutItem => ({
    label: `练习${partial.index}`,
    preview: '……',
    hasFigure: false,
    ...partial,
})

describe('pickPhotoItem：照片里认出多道题时选哪道', () => {
    it('只有一道就是它', () => {
        const only = item({ index: 1, box: [0.1, 0.1, 0.9, 0.9] })
        expect(pickPhotoItem([only])).toBe(only)
    })

    it('多道题选面积最大的——孩子拍照以目标题为主体', () => {
        const edge = item({ index: 1, box: [0, 0, 1, 0.15] }) // 上一题的尾巴挤进取景框
        const main = item({ index: 2, box: [0, 0.15, 1, 0.95] })
        expect(pickPhotoItem([edge, main])).toBe(main)
    })

    it('光杆题号（dangling）不参选', () => {
        const dangling = item({ index: 1, box: [0, 0, 1, 0.98], dangling: true })
        const real = item({ index: 2, box: [0, 0.2, 0.8, 0.6] })
        expect(pickPhotoItem([dangling, real])).toBe(real)
    })

    it('都没有框时退回第一条（后续会用整张照片识别）', () => {
        const a = item({ index: 1 })
        const b = item({ index: 2 })
        expect(pickPhotoItem([a, b])).toBe(a)
    })

    it('有框的优先于没框的——框裁出来的图干扰更少', () => {
        const noBox = item({ index: 1 })
        const withBox = item({ index: 2, box: [0.2, 0.2, 0.6, 0.5] })
        expect(pickPhotoItem([noBox, withBox])).toBe(withBox)
    })

    it('一条都没有 → null（前端据此提示重拍）', () => {
        expect(pickPhotoItem([])).toBeNull()
        expect(pickPhotoItem([item({ index: 1, dangling: true })])).toBeNull()
    })
})

describe('figurePadBox：配图裁框的余量与答案线', () => {
    it('上/左/右放大 0.05 救回被裁掉的顶点标签', () => {
        expect(figurePadBox([0.68, 0.38, 0.95, 0.6], undefined)).toEqual([
            0.68 - 0.05,
            0.38 - 0.05,
            1,
            0.65,
        ])
    })

    it('下边绝不越过答案线——服务端钳到 answerTop 的框不许被余量扩回去', () => {
        // 实机事故的形状：图框下边被 clampToAnswer 压在答案线上
        const padded = figurePadBox([0.3, 0.2, 0.7, 0.6], 0.6)
        expect(padded[3]).toBe(0.6)
        // 其余三边照常放大
        expect(padded[0]).toBeCloseTo(0.25)
        expect(padded[1]).toBeCloseTo(0.15)
        expect(padded[2]).toBeCloseTo(0.75)
    })

    it('图框离答案线不足 0.05 时，余量只吃到答案线为止', () => {
        expect(figurePadBox([0.3, 0.2, 0.7, 0.58], 0.6)[3]).toBe(0.6)
    })

    it('没有答案线（学生版）时下边照常放大', () => {
        expect(figurePadBox([0.3, 0.2, 0.7, 0.6], undefined)[3]).toBeCloseTo(0.65)
    })

    it('出界一律钳回 0~1', () => {
        expect(figurePadBox([0.01, 0.02, 0.99, 0.98], undefined)).toEqual([0, 0, 1, 1])
    })
})


describe('textLineAxis：像素判文字走向（校验模型的方向判定）', () => {
    // 合成"一页字"：横排 = 每 8 行里 4 行有墨迹（整行随机点），列向均匀
    function page(w: number, h: number, horizontal: boolean): Uint8Array {
        const gray = new Uint8Array(w * h).fill(240)
        let seed = 7
        const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
        for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
                const inLine = horizontal ? y % 8 < 4 : x % 8 < 4
                if (inLine && rnd() < 0.35) gray[y * w + x] = 30
            }
        }
        return gray
    }
    it('横排文字 → horizontal；竖排（侧拍） → vertical', () => {
        expect(textLineAxis(page(200, 160, true), 200, 160)).toBe('horizontal')
        expect(textLineAxis(page(200, 160, false), 200, 160)).toBe('vertical')
    })
    it('几乎没墨迹或不成行（纯图形/噪点）→ unknown，不下结论', () => {
        const blank = new Uint8Array(200 * 160).fill(240)
        expect(textLineAxis(blank, 200, 160)).toBe('unknown')
        const noise = new Uint8Array(200 * 160)
        let seed = 3
        for (let i = 0; i < noise.length; i += 1) {
            seed = (seed * 9301 + 49297) % 233280
            noise[i] = seed / 233280 < 0.2 ? 30 : 240
        }
        expect(textLineAxis(noise, 200, 160)).toBe('unknown')
    })
})
