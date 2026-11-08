import { useMemo } from 'react'
import { validateWidgetHtml, widgetSandboxAttr } from '@mathtutor/widgets'
import { buildSandboxedDocument } from './sandboxDoc'

/**
 * 自由生成的 HTML 组件的渲染框。
 *
 * 兜底不能是一个能随便跑的页面：这段 HTML 的作者是模型，跑在孩子的机器上。
 * 所以这里有两道**独立的**锁，缺一条都不算沙箱：
 * 1. iframe 的 sandbox="allow-scripts"——不给 allow-same-origin，脚本就碰不到
 *    本站的 cookie、localStorage、DOM，也拿不到父窗口；
 * 2. iframe 内的 CSP meta——default-src 'none' 掐掉一切网络与外链，
 *    只剩内联脚本与内联样式（组件就是这两样）。
 * 校验（validateWidgetHtml）只是把常见坏味道提前挡掉、给出人话，不是第三道锁：
 * 它挡不住所有写法，真正兜底的是上面两条，所以校验通过也照样进沙箱。
 */
export function GeneratedWidgetFrame({
  html,
  title = '互动组件',
  height = 360,
}: {
  html: string
  title?: string
  height?: number
}) {
  const validation = useMemo(() => validateWidgetHtml(html), [html])
  const doc = useMemo(() => (validation.ok ? buildSandboxedDocument(html) : ''), [html, validation.ok])

  if (!validation.ok) {
    return (
      <div className="rounded-[10px] border border-rule bg-paper px-4 py-3 text-sm text-ink-soft space-y-1.5">
        <p className="font-semibold text-ink">这个小组件没能显示出来：它没有通过安全检查。</p>
        <ul className="list-disc pl-5 text-xs text-ink-faint space-y-0.5">
          {validation.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        <p className="text-xs text-ink-faint">
          宁可少看一个组件，也不把一个能联网、能读本地数据的页面放进浏览器。
        </p>
      </div>
    )
  }

  return (
    <iframe
      title={title}
      srcDoc={doc}
      sandbox={widgetSandboxAttr()}
      referrerPolicy="no-referrer"
      className="w-full rounded-[10px] border border-rule bg-plate"
      style={{ height }}
    />
  )
}
