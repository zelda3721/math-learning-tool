import { describe, expect, it } from 'vitest'
import { validateWidgetHtml, widgetCsp } from '@mathtutor/widgets'
import { buildSandboxedDocument } from './sandboxDoc'

/**
 * 沙箱文档的测试：CSP 没进 head，锁就等于没上。
 *
 * 这里测的是"锁有没有装上"，不是"组件好不好看"——模型的 HTML 是不可信输入，
 * 唯一能把网络与外链掐死的地方就是那个 meta。
 */
describe('buildSandboxedDocument', () => {
    it('片段：包一层带 CSP 的文档', () => {
        const doc = buildSandboxedDocument('<p>hi</p>')
        expect(doc).toContain('<!doctype html>')
        expect(doc).toContain('http-equiv="Content-Security-Policy"')
        expect(doc).toContain("default-src 'none'")
        expect(doc).toContain('<p>hi</p>')
    })

    it('整份文档：meta 插进 head，而且只插一次', () => {
        const input = '<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>'
        const doc = buildSandboxedDocument(input)
        expect(doc.match(/Content-Security-Policy/g)).toHaveLength(1)
        // 必须落在 head 里：放在 body 里的 CSP meta 不生效
        const headEnd = doc.indexOf('</head>')
        expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(headEnd)
        expect(doc).toContain('<title>t</title>')
        expect(doc).toContain('<p>x</p>')
    })

    it('有 <html> 但没 head：补一个 head 再放 meta', () => {
        const doc = buildSandboxedDocument('<html><body>y</body></html>')
        expect(doc).toContain('<head>')
        expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<body>'))
        expect(doc).toContain('y')
    })

    it('CSP 的关键几条都在：不许联网、不许外链、不许同源外跳', () => {
        const csp = widgetCsp()
        expect(csp).toContain("default-src 'none'")
        expect(csp).toContain("connect-src 'none'")
        expect(csp).toContain("frame-src 'none'")
        expect(csp).toContain("base-uri 'none'")
        // 内联脚本是组件本身需要的，但 eval 类动态执行不能放行
        expect(csp).not.toContain('unsafe-eval')
        expect(buildSandboxedDocument('<p/>')).toContain('connect-src')
    })
})

describe('校验只是提前拦，不是第三道锁', () => {
    it('外部脚本、联网、跳出沙箱都会被挡下，并且给出人话理由', () => {
        const bad = '<script src="https://evil.example/x.js"></script>'
        const result = validateWidgetHtml(bad)
        expect(result.ok).toBe(false)
        expect(result.errors.join()).toContain('外部脚本')

        expect(validateWidgetHtml('<script>fetch("https://x")</script>').ok).toBe(false)
        expect(validateWidgetHtml('<script>window.top.location = "/"</script>').ok).toBe(false)
    })

    it('干净的内联组件能过', () => {
        expect(validateWidgetHtml('<svg><circle r="4"/></svg><script>1+1</script>').ok).toBe(true)
    })
})
