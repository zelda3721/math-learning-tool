// 移植自 math-wiki src/dom.ts（原样拷入）
// 极简 DOM / SVG 构造助手（零依赖，替代框架）

type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>
type Child = Node | string | null | undefined | false

const SVG_NS = 'http://www.w3.org/2000/svg'

function applyAttrs(el: Element, attrs?: Attrs) {
  if (!attrs) return
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') el.setAttribute('class', String(v))
    else if (k === 'style') el.setAttribute('style', String(v))
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '')
    } else {
      el.setAttribute(k, String(v))
    }
  }
}

function appendChildren(el: Element, children?: Child[]) {
  if (!children) return
  for (const c of children) {
    if (c == null || c === false) continue
    el.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
}

/** 创建 HTML 元素 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Child[],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  applyAttrs(el, attrs)
  appendChildren(el, children)
  return el
}

/** 创建 SVG 元素（命名空间） */
export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Child[],
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  applyAttrs(el, attrs)
  appendChildren(el, children)
  return el
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild)
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
