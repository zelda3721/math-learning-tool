import { describe, expect, it } from 'vitest'
import { EXPLANATION_SANDBOX } from './GeneratedExplanation'

describe('模型直写讲解的沙箱策略', () => {
    it('给脚本，但绝不给 allow-same-origin', () => {
        const tokens = EXPLANATION_SANDBOX.split(/\s+/).filter(Boolean)
        expect(tokens).toContain('allow-scripts')
        // 两者同时给等于没有沙箱：文档会拿回主站源，模型写的 JS 能读会话 cookie
        expect(tokens).not.toContain('allow-same-origin')
    })

    it('不放行导航、弹窗、表单与顶层跳转', () => {
        const tokens = EXPLANATION_SANDBOX.split(/\s+/).filter(Boolean)
        for (const risky of [
            'allow-top-navigation',
            'allow-top-navigation-by-user-activation',
            'allow-popups',
            'allow-forms',
            'allow-modals',
            'allow-downloads',
            'allow-storage-access-by-user-activation',
        ]) {
            expect(tokens).not.toContain(risky)
        }
    })
})
