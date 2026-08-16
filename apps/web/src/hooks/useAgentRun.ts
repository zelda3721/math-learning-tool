/**
 * useAgentRun — runs the harness agent against `/api/v1/chat` SSE and
 * accumulates events into a UI-friendly timeline.
 */
import { useCallback, useReducer, useRef } from 'react'

import { postSSE } from '../services/sseClient'
import { api } from '../services/api'
import type {
    AgentEvent,
    AgentRunState,
    DoneEvent,
    ErrorEvent,
    ReasoningEvent,
    SessionEvent,
    TextEvent,
    TimelineItem,
    ToolArtifactRecord,
    ToolCallEvent,
    ToolResultEvent,
} from '../types/agent'

type Action =
    | { type: 'RESET' }
    | { type: 'EVENT'; event: AgentEvent }
    | { type: 'STREAM_ERROR'; message: string }
    | { type: 'STREAM_END' }

const INITIAL_STATE: AgentRunState = {
    sessionId: null,
    status: 'idle',
    items: [],
    finalVideoUrl: null,
    subtitleUrl: null,
    finalText: '',
    error: null,
}

function reducer(state: AgentRunState, action: Action): AgentRunState {
    if (action.type === 'RESET') return { ...INITIAL_STATE }
    if (action.type === 'STREAM_END') {
        if (state.status !== 'running') return state
        return {
            ...state,
            status: 'failed',
            error: '与生成服务的连接中断。生成可能仍在后台进行，稍后可在历史记录中查看结果。',
        }
    }
    if (action.type === 'STREAM_ERROR') {
        return { ...state, status: 'failed', error: action.message }
    }

    const evt = action.event
    switch (evt.type) {
        case 'session':
            return applySession(state, evt)
        case 'text':
            return applyText(state, evt)
        case 'reasoning':
            return applyReasoning(state, evt)
        case 'tool_call':
            return applyToolCall(state, evt)
        case 'tool_result':
            return applyToolResult(state, evt)
        case 'done':
            return applyDone(state, evt)
        case 'error':
            return applyError(state, evt)
        default:
            return state
    }
}

function applySession(state: AgentRunState, evt: SessionEvent): AgentRunState {
    return { ...state, sessionId: evt.session_id, status: 'running' }
}

function applyText(state: AgentRunState, evt: TextEvent): AgentRunState {
    if (!evt.text) return state
    const last = state.items[state.items.length - 1]
    if (last && last.kind === 'message') {
        const updated: TimelineItem = { ...last, text: last.text + evt.text }
        return {
            ...state,
            items: [...state.items.slice(0, -1), updated],
            finalText: state.finalText + evt.text,
        }
    }
    const item: TimelineItem = {
        kind: 'message',
        key: `m-${state.items.length}`,
        text: evt.text,
    }
    return {
        ...state,
        items: [...state.items, item],
        finalText: state.finalText + evt.text,
    }
}

function applyReasoning(state: AgentRunState, evt: ReasoningEvent): AgentRunState {
    if (!evt.text) return state
    const last = state.items[state.items.length - 1]
    if (last && last.kind === 'reasoning') {
        const updated: TimelineItem = { ...last, text: last.text + evt.text }
        return { ...state, items: [...state.items.slice(0, -1), updated] }
    }
    const item: TimelineItem = {
        kind: 'reasoning',
        key: `r-${state.items.length}`,
        text: evt.text,
    }
    return { ...state, items: [...state.items, item] }
}

function applyToolCall(state: AgentRunState, evt: ToolCallEvent): AgentRunState {
    const item: TimelineItem = {
        kind: 'tool',
        key: `t-${evt.id}`,
        callId: evt.id,
        name: evt.name,
        arguments: evt.arguments,
        status: 'running',
        artifacts: [],
    }
    return { ...state, items: [...state.items, item] }
}

function applyToolResult(state: AgentRunState, evt: ToolResultEvent): AgentRunState {
    const reviewRejected =
        evt.name === 'watch_video' && evt.data?.['overall_quality'] === 'bad'
    const expectedGateRevision =
        !evt.success &&
        ['verify_solution', 'direct_video'].includes(evt.name)
    const items = state.items.map((it) => {
        if (it.kind !== 'tool' || it.callId !== evt.id) return it
        const updated: TimelineItem = {
            ...it,
            status:
                reviewRejected || expectedGateRevision
                    ? 'revision'
                    : evt.success
                      ? 'success'
                      : 'failed',
            summary: evt.summary,
            data: evt.data ?? undefined,
            error: evt.error ?? undefined,
            durationMs: evt.duration_ms ?? undefined,
            artifacts: evt.artifacts || [],
        }
        return updated
    })

    let finalVideoUrl = state.finalVideoUrl
    // A rendered MP4 is only a candidate. Publish it after the final Watch
    // quality gate passes; otherwise a failed/revision candidate leaks into
    // the player before the workflow has accepted it.
    if (evt.name === 'watch_video' && evt.success && evt.data) {
        const candidate =
            (evt.data['video_url'] as string | undefined) ||
            (evt.data['video_path'] as string | undefined)
        if (candidate) {
            finalVideoUrl = candidate.startsWith('/api/')
                ? candidate
                : pathToUrl(candidate)
        }
    }
    let subtitleUrl = state.subtitleUrl
    const subtitle = evt.artifacts?.find((artifact) => artifact.kind === 'subtitle')
    if (subtitle && state.sessionId) {
        subtitleUrl = `/api/v1/sessions/${state.sessionId}/artifacts/${subtitle.id}`
    }
    return { ...state, items, finalVideoUrl, subtitleUrl }
}

function applyDone(state: AgentRunState, evt: DoneEvent): AgentRunState {
    const delivered = evt.status === 'ok'
    return {
        ...state,
        status: delivered ? 'done' : evt.status === 'exhausted' ? 'exhausted' : 'failed',
        finalVideoUrl: delivered ? evt.final_video_url || state.finalVideoUrl : null,
        subtitleUrl: delivered ? state.subtitleUrl : null,
        finalText: evt.text || state.finalText,
    }
}

function applyError(state: AgentRunState, evt: ErrorEvent): AgentRunState {
    return {
        ...state,
        status: evt.fatal ? 'failed' : state.status,
        error: evt.message,
    }
}

function pathToUrl(p: string): string {
    if (p.includes('videos/')) {
        const sub = p.split('videos/').slice(1).join('videos/')
        return `/api/v1/media/videos/${sub}`
    }
    return `/api/v1/media/videos/${p}`
}

export interface StartArgs {
    problem: string
    grade: string
    extraDirectives?: string
    /** 原题原图（data URL，拍题识别裁出）；引擎按它的转写重画，不传就只能凭题干想象 */
    figureImage?: string
}

export interface UseAgentRun {
    state: AgentRunState
    start: (args: StartArgs) => Promise<void>
    abort: () => void
    reset: () => void
}

export function useAgentRun(): UseAgentRun {
    const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
    const abortRef = useRef<AbortController | null>(null)

    const reset = useCallback(() => {
        abortRef.current?.abort()
        dispatch({ type: 'RESET' })
    }, [])

    const abort = useCallback(() => {
        abortRef.current?.abort()
    }, [])

    const start = useCallback(async ({ problem, grade, extraDirectives, figureImage }: StartArgs) => {
        abortRef.current?.abort()
        dispatch({ type: 'RESET' })

        const controller = new AbortController()
        abortRef.current = controller

        try {
            const stream = postSSE<unknown>(
                api.chatStreamUrl(),
                {
                    problem,
                    grade,
                    extra_directives: extraDirectives,
                    ...(figureImage ? { figure_image: figureImage } : {}),
                },
                { signal: controller.signal }
            )

            for await (const message of stream) {
                if (controller.signal.aborted) break
                const evt = sseToAgentEvent(message.event, message.data)
                if (evt) dispatch({ type: 'EVENT', event: evt })
            }
            // 流结束但没收到终态事件（代理被掐/引擎断连）——必须报错，
            // 否则界面永远停在"生成中"（实机：undici 掐断 SSE 后就是这个样子）
            if (!controller.signal.aborted) dispatch({ type: 'STREAM_END' })
        } catch (err) {
            if (controller.signal.aborted) return
            const message = err instanceof Error ? err.message : String(err)
            dispatch({ type: 'STREAM_ERROR', message })
        }
    }, [])

    return { state, start, abort, reset }
}

function sseToAgentEvent(event: string, data: unknown): AgentEvent | null {
    if (typeof data !== 'object' || data === null) return null
    const obj = data as Record<string, unknown>
    switch (event) {
        case 'session':
            return { type: 'session', session_id: String(obj.session_id ?? '') }
        case 'text':
            return { type: 'text', text: String(obj.text ?? '') }
        case 'reasoning':
            return { type: 'reasoning', text: String(obj.text ?? '') }
        case 'tool_call':
            return {
                type: 'tool_call',
                id: String(obj.id ?? ''),
                name: String(obj.name ?? ''),
                arguments: (obj.arguments as Record<string, unknown>) || {},
                turn_index: Number(obj.turn_index ?? 0),
            }
        case 'tool_result':
            return {
                type: 'tool_result',
                id: String(obj.id ?? ''),
                name: String(obj.name ?? ''),
                success: Boolean(obj.success),
                summary: String(obj.summary ?? ''),
                data: (obj.data as Record<string, unknown>) ?? null,
                error: (obj.error as string) ?? null,
                duration_ms: (obj.duration_ms as number) ?? null,
                artifacts: (obj.artifacts as ToolArtifactRecord[] | undefined) ?? [],
            }
        case 'done':
            return {
                type: 'done',
                status: (obj.status as DoneEvent['status']) || 'ok',
                text: String(obj.text ?? ''),
                final_video_url: (obj.final_video_url as string) ?? null,
                final_video_path: (obj.final_video_path as string) ?? null,
            }
        case 'error':
            return {
                type: 'error',
                message: String(obj.message ?? ''),
                fatal: Boolean(obj.fatal),
            }
        default:
            return null
    }
}
