import { widgetCsp } from '@mathtutor/widgets'

/**
 * 把模型的 HTML 和 CSP 一起装进一个文档（纯函数，便于测试）。
 *
 * 模型有时给片段、有时给整份文档，两种都得处理：
 * - 整份文档（带 <head>）→ 把 meta 插进 head，别让浏览器再自作主张开一个；
 * - 片段 → 包一层我们自己的 head（同时带上 charset，中文才不会花屏）。
 *
 * 一定要进 head：写在 body 里的 CSP meta 浏览器不认，锁就等于没上。
 * 所以这条逻辑单独成文件、单独写测试——它坏掉不会有任何报错，只会静默地不安全。
 */
export function buildSandboxedDocument(html: string, csp: string = widgetCsp()): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">`
  const charset = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (head) => `${head}${meta}${charset}`)
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${charset}${meta}</head>`)
  }
  return `<!doctype html><html lang="zh-CN"><head>${charset}${meta}<style>html,body{margin:0;padding:12px;font-family:system-ui,sans-serif;color:#16203a}</style></head><body>${html}</body></html>`
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
