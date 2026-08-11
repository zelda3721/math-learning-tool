import { describe, expect, it } from 'vitest'
import { judgeTextLayer } from './pdfPages'

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
