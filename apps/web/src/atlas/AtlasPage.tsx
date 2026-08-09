// 「星图」页：React 受控挂载 TreeCanvas（useRef 容器 + useEffect 创建/销毁）
// 数据源：/api/v1/atlas?learnerId=（server 返回 {graph, problemTypes, mastery}）；
// 失败时回退本地快照 graph.local.json。P1a：掌握度按 band（dim/glow/lit）给节点着色。
import { useEffect, useMemo, useRef, useState } from 'react'

import { TreeCanvas, type MasteryMap } from './treeCanvas'
import { createGraphIndex } from './graphIndex'
import { NodeDetail } from './NodeDetail'
import { useLearner } from '../learner/LearnerContext'
import type { Graph, ProblemType } from './types'
import localGraphRaw from './graph.local.json'
import './atlas.css'

interface MasteryEntry {
    p?: number
    evidenceN?: number
    band: 'dim' | 'glow' | 'lit'
}

interface AtlasData {
    graph: Graph
    problemTypes?: ProblemType[]
    mastery?: Record<string, MasteryEntry>
}

type AtlasSource = 'api' | 'local'

function localFallback(): AtlasData {
    return { graph: localGraphRaw as unknown as Graph }
}

/** 服务端 mastery → TreeCanvas 着色 map（丢弃 band 非法的条目） */
function toMasteryMap(raw: Record<string, MasteryEntry> | undefined): MasteryMap {
    const out: MasteryMap = {}
    for (const [nodeId, m] of Object.entries(raw ?? {})) {
        if (m && (m.band === 'dim' || m.band === 'glow' || m.band === 'lit')) {
            out[nodeId] = { band: m.band }
        }
    }
    return out
}

async function fetchAtlas(learnerId: string | null): Promise<AtlasData> {
    const url = learnerId ? `/api/v1/atlas?learnerId=${encodeURIComponent(learnerId)}` : '/api/v1/atlas'
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body: unknown = await res.json()
    const data = body as Partial<AtlasData>
    if (!data.graph?.nodes?.length || !data.graph.stages?.length || !data.graph.strands?.length) {
        throw new Error('atlas payload missing graph')
    }
    return { graph: data.graph, problemTypes: data.problemTypes, mastery: data.mastery }
}

export function AtlasPage() {
    const { learner } = useLearner()
    const [data, setData] = useState<AtlasData | null>(null)
    const [source, setSource] = useState<AtlasSource>('api')
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const containerRef = useRef<HTMLDivElement | null>(null)
    const canvasRef = useRef<TreeCanvas | null>(null)

    const learnerId = learner?.id ?? null

    useEffect(() => {
        let cancelled = false
        fetchAtlas(learnerId)
            .then((d) => {
                if (cancelled) return
                setSource('api')
                setData(d)
            })
            .catch(() => {
                if (cancelled) return
                setSource('local')
                setData(localFallback())
            })
        return () => {
            cancelled = true
        }
    }, [learnerId])

    const gi = useMemo(() => (data ? createGraphIndex(data.graph) : null), [data])
    const masteryMap = useMemo(() => toMasteryMap(data?.mastery), [data])
    const litCount = useMemo(
        () => Object.values(masteryMap).filter((m) => m.band !== 'dim').length,
        [masteryMap]
    )

    // 受控挂载：数据就绪后创建 TreeCanvas，卸载/换数据时销毁；掌握度随建随染
    useEffect(() => {
        const el = containerRef.current
        if (!data || !el) return
        const canvas = new TreeCanvas(el, data.graph, { onSelect: setSelectedId })
        canvas.setMastery(masteryMap)
        canvasRef.current = canvas
        return () => {
            canvas.destroy()
            canvasRef.current = null
        }
    }, [data, masteryMap])

    const jumpTo = (id: string) => canvasRef.current?.focusAndSelect(id)
    const closeDetail = () => {
        canvasRef.current?.setSelected(null)
        setSelectedId(null)
    }

    const masteryHint = !learner
        ? '未选择学习者·掌握度未着色'
        : source === 'local'
          ? '离线快照·掌握度不可用'
          : litCount > 0
            ? `${learner.name} 已点亮 ${litCount} 个知识点`
            : `${learner.name}·尚无掌握度数据`

    return (
        <div
            className="atlas-root relative w-full overflow-hidden rounded-2xl border border-slate-200 shadow-sm"
            style={{ height: 'calc(100vh - 170px)', minHeight: 420 }}
        >
            <div ref={containerRef} className="atlas-canvas" />

            {!data && (
                <div className="absolute inset-0 grid place-items-center text-slate-400 text-sm">
                    星图加载中…
                </div>
            )}

            {data && (
                <div className="absolute left-3 top-3 z-10 rounded-full border border-slate-200 bg-white/85 px-3 py-1 text-xs text-slate-400">
                    {source === 'api' ? '数据：/api/v1/atlas' : '数据：离线快照 graph.local.json'}
                    <span className="mx-1">·</span>
                    {masteryHint}
                </div>
            )}

            <div className="zoom-ctl">
                <button type="button" onClick={() => canvasRef.current?.zoomBy(1.25)} aria-label="放大">
                    ＋
                </button>
                <button type="button" onClick={() => canvasRef.current?.zoomBy(1 / 1.25)} aria-label="缩小">
                    －
                </button>
                <button type="button" onClick={() => canvasRef.current?.fitView()} aria-label="复位视图">
                    ⤢
                </button>
            </div>

            {gi && selectedId && (
                <NodeDetail gi={gi} id={selectedId} onJump={jumpTo} onClose={closeDetail} />
            )}
        </div>
    )
}
