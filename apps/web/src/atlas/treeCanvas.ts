// 移植自 math-wiki src/treeCanvas.ts —— 最小适配：
//  - 去掉 state.ts/store 依赖：选中/悬停/光路状态内聚在类里，经 onSelect 回调对外通知
//  - 图数据经构造参数注入（graph.ts 单例改为 createGraphIndex 工厂）
//  - 去掉搜索高亮/主线过滤/学习进度/相机巡游（P0 掌握度全灰、不着色）
//  - 新增 destroy()/setSelected() 供 React 受控挂载使用
import { s, clear, prefersReducedMotion } from './dom'
import { computeLayout, type Layout, type NodeBox } from './layout'
import { createGraphIndex, type GraphIndex } from './graphIndex'
import type { Graph, KnowledgeNode } from './types'

interface T {
  x: number
  y: number
  k: number
}

export interface TreeCanvasOptions {
  /** 节点被点击选中（或点空白取消选中）时回调 */
  onSelect?: (id: string | null) => void
}

export type MasteryBand = 'dim' | 'glow' | 'lit'
export type MasteryMap = Record<string, { band: MasteryBand }>

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function splitName(name: string): string[] {
  if (name.length <= 6) return [name]
  // 在中点附近、优先于「的/与/和」等处断行
  const mid = Math.ceil(name.length / 2)
  for (let d = 0; d < 3; d++) {
    for (const i of [mid + d, mid - d]) {
      if (i > 0 && i < name.length && '的与和·、'.includes(name[i - 1])) {
        return [name.slice(0, i), name.slice(i)]
      }
    }
  }
  return [name.slice(0, mid), name.slice(mid)]
}

const frontierNode = (n: KnowledgeNode) =>
  n.stage === 'university' || n.applications.some((a) => a.frontier)

export class TreeCanvas {
  private graph: Graph
  private gi: GraphIndex
  private layout: Layout
  private svg!: SVGSVGElement
  private viewport!: SVGGElement
  private nodeLayer!: SVGGElement
  private linkLayer!: SVGGElement
  private beamLayer!: SVGGElement
  private labelLayer!: SVGGElement
  private relLayer!: SVGGElement
  private labelRects: Array<[number, number, number, number]> = [] // 已放置标签的包围盒，用于互相避让
  private nodeEls = new Map<string, SVGGElement>()
  private linkEls: { el: SVGPathElement; from: string; to: string }[] = []
  private t: T = { x: 0, y: 0, k: 1 }
  private container: HTMLElement

  private selectedId: string | null = null
  private hoverId: string | null = null
  private mastery: MasteryMap = {}
  private beamActive = true
  private lastFocus: string | null = null
  private destroyed = false
  private onSelectCb?: (id: string | null) => void

  constructor(container: HTMLElement, graph: Graph, opts: TreeCanvasOptions = {}) {
    this.container = container
    this.graph = graph
    this.gi = createGraphIndex(graph)
    this.layout = computeLayout(graph)
    this.onSelectCb = opts.onSelect
    this.build()
    requestAnimationFrame(() => this.fitView())
  }

  /** React 卸载时调用：清空容器（所有事件都绑在 svg 上，随之释放） */
  destroy() {
    this.destroyed = true
    clear(this.container)
  }

  // ─────────────────────────────── build ───────────────────────────────
  private build() {
    clear(this.container)
    const svg = s('svg', { class: 'tree-svg', xmlns: 'http://www.w3.org/2000/svg' })
    svg.append(this.defs())
    const viewport = s('g', { class: 'viewport' })
    const bg = this.buildBackground()
    this.linkLayer = s('g', { class: 'links' })
    this.beamLayer = s('g', { class: 'beams' })
    this.nodeLayer = s('g', { class: 'nodes' })
    this.labelLayer = s('g', { class: 'beam-labels' }) // 在节点之上，避免被节点遮挡
    this.relLayer = s('g', { class: 'rel-labels' }) // 前置/由来 关系层
    viewport.append(bg, this.linkLayer, this.beamLayer, this.nodeLayer, this.relLayer, this.labelLayer)
    svg.append(viewport)
    this.svg = svg
    this.viewport = viewport
    this.container.append(svg)

    this.buildLinks()
    this.buildNodes()
    this.bindInteractions()
    this.applyTransform()
    this.applyMastery() // rerender 后保持掌握度着色
  }

  /** 掌握度着色：dim=现状灰、glow=琥珀微光、lit=点亮（金色渐变+发光描边）。
   *  未出现在 map 中的节点保持现状；重复调用/重建后均会重新应用。 */
  setMastery(map: MasteryMap) {
    this.mastery = map ?? {}
    this.applyMastery()
  }

  private applyMastery() {
    for (const [id, el] of this.nodeEls) {
      const band = this.mastery[id]?.band
      el.classList.toggle('m-dim', band === 'dim')
      el.classList.toggle('m-glow', band === 'glow')
      el.classList.toggle('m-lit', band === 'lit')
    }
  }

  private defs(): SVGDefsElement {
    const defs = s('defs')
    const grad = s('linearGradient', { id: 'beamGrad', x1: '0', y1: '0', x2: '1', y2: '0' })
    grad.append(
      s('stop', { offset: '0%', 'stop-color': '#fbbf24' }),
      s('stop', { offset: '50%', 'stop-color': '#38bdf8' }),
      s('stop', { offset: '100%', 'stop-color': '#a855f7' }),
    )
    defs.append(grad)
    // 掌握度「点亮」节点的金色渐变填充（CSS 中经 url(#masteryLitGrad) 引用）
    const litGrad = s('linearGradient', { id: 'masteryLitGrad', x1: '0', y1: '0', x2: '1', y2: '1' })
    litGrad.append(
      s('stop', { offset: '0%', 'stop-color': '#fef3c7' }),
      s('stop', { offset: '55%', 'stop-color': '#fde68a' }),
      s('stop', { offset: '100%', 'stop-color': '#fbbf24' }),
    )
    defs.append(litGrad)
    const mk = (id: string, color: string) => {
      const m = s('marker', {
        id,
        viewBox: '0 0 10 10',
        refX: '8',
        refY: '5',
        markerWidth: '7',
        markerHeight: '7',
        orient: 'auto-start-reverse',
      })
      m.append(s('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }))
      return m
    }
    defs.append(mk('arrow', '#c2cbd9'), mk('arrowHot', '#6366f1'), mk('arrowBeam', '#a855f7'), mk('arrowPrereq', '#0ea5e9'))
    const glow = s('filter', { id: 'glow', x: '-30%', y: '-30%', width: '160%', height: '160%' })
    glow.append(
      s('feGaussianBlur', { stdDeviation: '3.2', result: 'b' }),
      s('feMerge', {}, [s('feMergeNode', { in: 'b' }), s('feMergeNode', { in: 'SourceGraphic' })]),
    )
    defs.append(glow)
    return defs
  }

  private buildBackground(): SVGGElement {
    const g = s('g', { class: 'bg' })
    const { width, height, stageBands, strandBands } = this.layout
    // 主线横带
    for (let i = 0; i < strandBands.length; i++) {
      const b = strandBands[i]
      const strand = this.gi.strandById.get(b.id)!
      g.append(
        s('rect', {
          x: 8,
          y: b.y,
          width: width - 16,
          height: b.h,
          rx: 18,
          class: 'strand-band',
          fill: strand.color,
          'fill-opacity': i % 2 === 0 ? '0.05' : '0.025',
        }),
      )
      // 左侧主线标签（限制在左侧栏宽内，避免被节点遮挡）
      const sub = strand.oneLine.length > 9 ? strand.oneLine.slice(0, 9) + '…' : strand.oneLine
      const label = s('g', { class: 'strand-label', transform: `translate(20 ${b.y + 30})` })
      label.append(
        s('text', { class: 'strand-icon', x: 0, y: 0 }, [strand.icon]),
        s('text', { class: 'strand-name', x: 0, y: 26, fill: strand.color }, [strand.name]),
        s('text', { class: 'strand-sub', x: 0, y: 44 }, [sub]),
      )
      g.append(label)
    }
    // 学段竖列分隔与标签
    for (const b of stageBands) {
      const stage = this.gi.stageById.get(b.id)!
      g.append(
        s('rect', { x: b.x, y: 64, width: 2, height: height - 80, fill: stage.accent, 'fill-opacity': '0.18' }),
      )
      const head = s('g', { class: 'stage-head', transform: `translate(${b.x + b.w / 2} 40)` })
      head.append(
        s('rect', { x: -56, y: -22, width: 112, height: 34, rx: 17, fill: stage.accent, 'fill-opacity': '0.16' }),
        s('text', { class: 'stage-name', x: 0, y: 0, fill: stage.accent }, [stage.name]),
        s('text', { class: 'stage-age', x: 0, y: 16 }, [stage.ageRange]),
      )
      g.append(head)
    }
    return g
  }

  private buildLinks() {
    for (const n of this.graph.nodes) {
      const from = this.layout.boxes.get(n.id)
      if (!from) continue
      for (const e of n.evolvesTo) {
        const to = this.layout.boxes.get(e.to)
        if (!to) continue
        // 跨节点支线（同一行越过中间节点）默认隐藏，只在聚焦时出现，保持默认视图干净
        const skip = this.isSkipLink(from, to)
        const path = s('path', {
          class: `link${skip ? ' skip' : ''}`,
          d: this.linkPath(from, to),
          'marker-end': 'url(#arrow)',
        }) as SVGPathElement
        this.linkLayer.append(path)
        this.linkEls.push({ el: path, from: n.id, to: e.to })
      }
    }
  }

  /** 同一行、且 a→b 之间还夹着别的节点（越过中间节点的"支线"） */
  private isSkipLink(a: NodeBox, b: NodeBox): boolean {
    if (Math.abs(b.cy - a.cy) >= 6) return false
    const x1 = a.x + a.w
    for (const box of this.layout.boxes.values()) {
      if (box === a || box === b) continue
      if (Math.abs(box.cy - a.cy) < 6 && box.x > x1 - 4 && box.x + box.w < b.x + 4) return true
    }
    return false
  }

  private linkPath(a: NodeBox, b: NodeBox): string {
    const x1 = a.x + a.w
    const y1 = a.cy
    const x2 = b.x - 8 // 在目标节点前收尾，让箭头露在缝里、不被卡片遮住
    const y2 = b.cy
    // 跨节点支线 → 向上拱起绕开，避免"穿过中间节点"的歧义
    if (this.isSkipLink(a, b)) {
      const dist = x2 - x1
      const bow = Math.min(Math.max(dist * 0.16, 46), 86)
      const cy = y1 - bow
      return `M${x1},${y1} C${x1 + dist * 0.28},${cy} ${x2 - dist * 0.28},${cy} ${x2},${y2}`
    }
    const dx = Math.max(40, (x2 - x1) * 0.5)
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
  }

  private buildNodes() {
    for (const box of this.layout.boxes.values()) {
      const n = box.node
      const strand = this.gi.strandById.get(n.strand)!
      const isFrontier = frontierNode(n)
      const isUni = n.stage === 'university'
      // 外层只负责定位（translate 属性），内层负责缩放动画——
      // 否则 SVG 里 CSS transform 会覆盖定位 translate，节点会塌到原点。
      const g = s('g', {
        class: `node strand-${n.strand} stage-${n.stage}${isUni ? ' is-uni' : ''}${isFrontier ? ' is-frontier' : ''}`,
        transform: `translate(${box.x} ${box.y})`,
        'data-id': n.id,
        tabindex: '0',
        role: 'button',
        'aria-label': `${n.name}（${this.gi.stageById.get(n.stage)!.name}）`,
      })
      const inner = s('g', { class: 'node-inner' })
      inner.append(
        s('rect', { class: 'node-card', x: 0, y: 0, width: box.w, height: box.h, rx: 14, fill: isUni ? strand.color : '#ffffff', stroke: strand.color }),
        s('rect', { class: 'node-bar', x: 0, y: 0, width: 6, height: box.h, rx: 3, fill: isUni ? '#ffffff' : strand.color }),
      )
      const lines = splitName(n.name)
      const text = s('text', { class: 'node-name', x: box.w / 2 + 3, y: lines.length > 1 ? box.h / 2 - 7 : box.h / 2 + 1, fill: isUni ? '#ffffff' : '#1f2733' })
      lines.forEach((ln, i) => text.append(s('tspan', { x: box.w / 2 + 3, dy: i === 0 ? 0 : 16 }, [ln])))
      inner.append(text)
      if (isFrontier) inner.append(s('text', { class: 'node-frontier', x: box.w - 12, y: 17 }, ['◆']))
      // P0：掌握度未接入，学习圆点保持统一灰色（.node-learn 默认样式）
      inner.append(s('circle', { class: 'node-learn', cx: 14, cy: 14, r: 5 }))
      g.append(inner)
      this.nodeLayer.append(g)
      this.nodeEls.set(n.id, g)
    }
  }

  // ─────────────────────────── interactions ───────────────────────────
  private bindInteractions() {
    let down: { x: number; y: number; tx: number; ty: number; id: string | null } | null = null
    let moved = false

    this.svg.addEventListener('pointerdown', (e) => {
      const target = e.target as Element
      const nodeG = target.closest('.node') as SVGGElement | null
      down = { x: e.clientX, y: e.clientY, tx: this.t.x, ty: this.t.y, id: nodeG?.getAttribute('data-id') ?? null }
      moved = false
      this.svg.setPointerCapture(e.pointerId)
      this.svg.classList.add('grabbing')
    })
    this.svg.addEventListener('pointermove', (e) => {
      if (!down) {
        const nodeG = (e.target as Element).closest('.node') as SVGGElement | null
        const id = nodeG?.getAttribute('data-id') ?? null
        if (id !== this.hoverId) {
          this.hoverId = id
          this.applyHighlight()
        }
        return
      }
      const dx = e.clientX - down.x
      const dy = e.clientY - down.y
      if (!moved && Math.hypot(dx, dy) > 4) moved = true
      if (moved) {
        this.t.x = down.tx + dx
        this.t.y = down.ty + dy
        this.applyTransform()
      }
    })
    this.svg.addEventListener('pointerup', (e) => {
      this.svg.classList.remove('grabbing')
      if (down && !moved) {
        if (down.id) this.select(down.id)
        else this.clearSelection()
      }
      try {
        this.svg.releasePointerCapture(e.pointerId)
      } catch {
        /* noop */
      }
      down = null
    })
    this.svg.addEventListener('pointerleave', () => {
      if (this.hoverId) {
        this.hoverId = null
        this.applyHighlight()
      }
    })

    this.svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const rect = this.svg.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
        const k2 = clamp(this.t.k * factor, 0.28, 2.6)
        const wx = (px - this.t.x) / this.t.k
        const wy = (py - this.t.y) / this.t.k
        this.t.x = px - wx * k2
        this.t.y = py - wy * k2
        this.t.k = k2
        this.applyTransform()
      },
      { passive: false },
    )

    // 键盘可达：回车选中聚焦节点
    this.svg.addEventListener('keydown', (e) => {
      const id = (e.target as Element).closest?.('.node')?.getAttribute('data-id')
      if (id && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        this.select(id)
      }
    })
  }

  private select(id: string) {
    this.selectedId = id
    this.onSelectCb?.(id)
    this.applyHighlight()
    this.focusNode(id, 1.0)
  }

  private clearSelection() {
    if (this.selectedId === null) return
    this.selectedId = null
    this.onSelectCb?.(null)
    this.applyHighlight()
  }

  /** 外部（React）受控设置选中：不触发 onSelect 回调，避免回环 */
  setSelected(id: string | null) {
    this.selectedId = id
    this.applyHighlight()
    if (id) this.focusNode(id, 1.0)
  }

  private applyTransform() {
    this.viewport.setAttribute('transform', `translate(${this.t.x} ${this.t.y}) scale(${this.t.k})`)
  }

  // ─────────────────────────── camera moves ───────────────────────────
  fitView() {
    const rect = this.container.getBoundingClientRect()
    if (!rect.width) return
    // 按高度铺满：四条主线行填满竖直方向，节点接近原始大小；左侧先显示小学，横向拖动看后续
    const k = clamp((rect.height - 28) / this.layout.height, 0.45, 1.5)
    const x = 28
    const y = Math.max(8, (rect.height - this.layout.height * k) / 2)
    this.animateTo({ x, y, k })
  }

  focusNode(id: string, targetK = 0.95) {
    const box = this.layout.boxes.get(id)
    const rect = this.container.getBoundingClientRect()
    if (!box || !rect.width) return
    const k = clamp(Math.max(this.t.k, targetK), 0.28, 2.0)
    // 把节点放在左侧 1/3 处，给右侧演化链留出视野
    this.animateTo({ k, x: rect.width * 0.34 - box.cx * k, y: rect.height * 0.5 - box.cy * k })
  }

  zoomBy(factor: number) {
    const rect = this.svg.getBoundingClientRect()
    const px = rect.width / 2
    const py = rect.height / 2
    const k2 = clamp(this.t.k * factor, 0.28, 2.6)
    const wx = (px - this.t.x) / this.t.k
    const wy = (py - this.t.y) / this.t.k
    this.animateTo({ x: px - wx * k2, y: py - wy * k2, k: k2 })
  }

  private animateTo(target: T) {
    if (prefersReducedMotion()) {
      this.t = target
      this.applyTransform()
      return
    }
    const start = { ...this.t }
    const t0 = performance.now()
    const dur = 420
    const ease = (p: number) => 1 - Math.pow(1 - p, 3)
    const step = (now: number) => {
      if (this.destroyed) return
      const p = Math.min(1, (now - t0) / dur)
      const e = ease(p)
      this.t = {
        x: start.x + (target.x - start.x) * e,
        y: start.y + (target.y - start.y) * e,
        k: start.k + (target.k - start.k) * e,
      }
      this.applyTransform()
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  // ─────────────────────────── highlight ───────────────────────────
  private applyHighlight() {
    const focus = this.hoverId ?? this.selectedId
    const { getNode, evolvedFrom, evolutionPath } = this.gi

    // beam path (仅选中 + 开启时)
    const beamSet = new Set<string>()
    const beamLinks = new Set<string>()
    if (this.selectedId && this.beamActive) {
      for (const seg of evolutionPath(this.selectedId)) {
        beamSet.add(seg.from)
        beamSet.add(seg.to)
        beamLinks.add(`${seg.from}→${seg.to}`)
      }
      beamSet.add(this.selectedId)
    }
    if (this.selectedId !== this.lastFocus) {
      this.labelRects = [] // 每次换选中节点，重置标签占位（光路与由来标签共用，互不重叠）
      this.renderBeam(this.selectedId, this.beamActive)
      this.renderRelations(this.selectedId)
      this.lastFocus = this.selectedId
    }

    // 局部高亮：只点亮"直接相关 + 这条演化主路径"，不再追整条前置/后代闭包
    let down = new Set<string>()
    let up = new Set<string>()
    let related = new Set<string>()
    let lit = new Set<string>()
    if (focus) {
      const fn = getNode(focus)
      // 前向：演化主路径(到前沿) + 直接演化分支(1 跳)
      down = new Set<string>(evolutionPath(focus).map((seg) => seg.to))
      for (const e of fn?.evolvesTo ?? []) down.add(e.to)
      // 后向：仅"直接前置 + 直接演化来源"(1 跳)
      up = new Set<string>([...(fn?.prerequisites ?? []), ...evolvedFrom(focus)])
      related = new Set<string>(fn?.relatedTo ?? [])
      down.delete(focus)
      up.delete(focus)
      lit = new Set<string>([focus, ...down, ...up, ...related])
    }

    for (const [id, el] of this.nodeEls) {
      el.classList.toggle('selected', id === this.selectedId)
      el.classList.toggle('hot', id === focus)
      el.classList.toggle('up', up.has(id))
      el.classList.toggle('down', down.has(id))
      el.classList.toggle('rel', related.has(id) && !up.has(id) && !down.has(id))
      el.classList.toggle('beam', beamSet.has(id))
      el.classList.toggle('dim', !!focus && !lit.has(id))
    }
    for (const l of this.linkEls) {
      const isBeam = beamLinks.has(`${l.from}→${l.to}`)
      // 连线只在两端节点都点亮时才高亮 —— 保证"亮线必连亮点"
      const bothLit = !!focus && lit.has(l.from) && lit.has(l.to)
      l.el.classList.toggle('hot', bothLit && !isBeam)
      l.el.classList.toggle('beam-link', isBeam)
      l.el.setAttribute('marker-end', isBeam ? 'url(#arrowBeam)' : bothLit ? 'url(#arrowHot)' : 'url(#arrow)')
      l.el.classList.toggle('dim', !!focus && !bothLit && !isBeam)
    }
  }

  private renderBeam(id: string | null, active: boolean) {
    clear(this.beamLayer)
    clear(this.labelLayer)
    if (!id || !active) return
    const segs = this.gi.evolutionPath(id)
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const a = this.layout.boxes.get(seg.from)
      const b = this.layout.boxes.get(seg.to)
      if (!a || !b) continue
      const path = s('path', {
        class: 'beam-path',
        d: this.linkPath(a, b),
        style: `animation-delay:${i * 0.12}s`,
      })
      this.beamLayer.append(path)
      // 「如何演化」标签抬到两行之间留白带的更高处（避免压住被跳过的中间节点）；跨度够大才标注
      if (seg.how && b.x - (a.x + a.w) > 120) {
        this.gutterLabel(this.labelLayer, (a.x + a.w + b.x) / 2, Math.min(a.cy, b.cy) - 92, seg.how, 'beam-howlabel')
      }
    }
  }

  /** 选中节点的"由来/前置"关系：在【本节点上方留白带】标注是怎么相关的，不画跨节点的连线、不遮挡 */
  private renderRelations(id: string | null) {
    clear(this.relLayer)
    if (!id) return
    const { getNode, evolvedFrom } = this.gi
    const fn = getNode(id)
    const fb = this.layout.boxes.get(id)
    if (!fn || !fb) return
    const sources = new Set(evolvedFrom(id))
    // 由来：每个演化来源「如何长成」本节点（复用演化 how）；标签放在本节点正上方留白带
    const incoming: string[] = []
    for (const P of sources) {
      const e = getNode(P)?.evolvesTo.find((x) => x.to === id)
      const from = getNode(P)?.name ?? P
      if (e?.how) incoming.push(`${from} —▶ ${e.how}`)
    }
    // 纯前置（不在演化来源里）：只点名「先掌握 X」，不画跨节点连线
    const pres = fn.prerequisites.filter((P) => !sources.has(P) && getNode(P)).map((P) => getNode(P)!.name)
    if (pres.length) incoming.push(`先掌握：${pres.join('、')}`)
    // 每条占一行，自下而上叠放在本节点上方的留白带；最多 3 条，多余的去详情面板看
    incoming.slice(0, 3).forEach((line, k) => this.gutterLabel(this.relLayer, fb.cx, fb.cy - 70 - k * 28, line, 'rel-howlabel'))
  }

  /** 在两行之间的留白带里放一条单行说明标签（y 为期望的中心纵坐标）。
   *  会避让已放置的标签：若与谁重叠就整体上移一行再试，保证标签之间互不遮挡。 */
  private gutterLabel(layer: SVGGElement, x: number, y: number, text: string, cls: string) {
    const w = text.length * 12 + 18
    const half = w / 2, h2 = 13, pad = 4
    let yy = y
    const overlaps = (r: [number, number, number, number]) =>
      this.labelRects.some((o) => !(r[2] + pad <= o[0] || r[0] - pad >= o[2] || r[3] + pad <= o[1] || r[1] - pad >= o[3]))
    for (let guard = 0; guard < 10 && overlaps([x - half, yy - h2, x + half, yy + h2]); guard++) yy -= 28
    this.labelRects.push([x - half, yy - h2, x + half, yy + h2])
    const g = s('g', { class: cls })
    g.append(s('rect', { x: x - half, y: yy - h2, width: w, height: 26, rx: 13 }), s('text', { x, y: yy }, [text]))
    layer.append(g)
  }

  /** 供外部（详情浮层 chips）聚焦并选中（会触发 onSelect 回调） */
  focusAndSelect(id: string) {
    this.select(id)
  }
}
