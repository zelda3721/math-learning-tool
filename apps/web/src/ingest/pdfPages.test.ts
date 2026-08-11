import { describe, expect, it } from 'vitest'
import { judgeTextLayer, toPdfData } from './pdfPages'

describe('PDF 文本层可信度判据', () => {
    it('真实讲义（每页约 6 个数字、约 120 处图形）判为不可信', () => {
        // 实测「第12讲 几何计数初步」：4 页，文本层里数字 5~7 个/页，
        // 位图 3~5、矢量路径 76~146。抽出来的题干长这样：
        //   「一块木板上有 ⟨空⟩ 枚钉子」——数量整个是空的
        const v = judgeTextLayer(6.25, 120)
        expect(v.trustworthy).toBe(false)
        expect(v.reason).toContain('缺数')
    })

    it('正常文本 PDF 判为可信', () => {
        expect(judgeTextLayer(85, 3).trustworthy).toBe(true)
        expect(judgeTextLayer(40, 18).trustworthy).toBe(true)
    })

    it('图形多但数字也多（如带坐标图的题库）仍算可信', () => {
        // 图多不等于数字缺；只有两者同时成立才说明数量被画走了
        expect(judgeTextLayer(60, 200).trustworthy).toBe(true)
    })

    it('数字少但没什么图形（如纯文字阅读材料）不误判', () => {
        expect(judgeTextLayer(3, 2).trustworthy).toBe(true)
    })
})

describe('交给 pdf.js 的必须是副本', () => {
    it('原缓冲区在复制之后仍然可用', () => {
        const src = new ArrayBuffer(64)
        new Uint8Array(src).fill(7)
        const copy = toPdfData(src)
        expect(copy.byteLength).toBe(64)
        expect(copy[0]).toBe(7)
        // 关键：调用方手里那份没有被动过——失败后还能改走图片上传
        expect(() => new Uint8Array(src)).not.toThrow()
        expect(new Uint8Array(src).byteLength).toBe(64)
    })

    it('复制出来的与原件互不影响', () => {
        const src = new ArrayBuffer(4)
        const copy = toPdfData(src)
        copy[0] = 9
        expect(new Uint8Array(src)[0]).toBe(0)
    })

    it('被转移走的缓冲区再用就是那条报错——这正是当初踩的坑', () => {
        // 实机报错：Cannot perform Construct on a detached ArrayBuffer
        // 起因是同一个 buffer 先后开了两次文档（体检一次、渲染一次）
        const buf = new ArrayBuffer(16)
        structuredClone(buf, { transfer: [buf] })
        expect(() => new Uint8Array(buf)).toThrow(/detached/i)
    })
})
