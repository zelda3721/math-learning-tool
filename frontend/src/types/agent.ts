/**
 * Type definitions mirroring the backend's SSE event protocol
 * (backend: infrastructure/agent/events.py, api/routes/chat.py).
 */

export interface SessionEvent {
    type: 'session'
    session_id: string
}

export interface TextEvent {
    type: 'text'
    text: string
}

export interface ReasoningEvent {
    type: 'reasoning'
    text: string
}

export interface ToolCallEvent {
    type: 'tool_call'
    id: string
    name: string
    arguments: Record<string, unknown>
    turn_index: number
}

export interface ToolArtifactRecord {
    id: number
    kind: string
    path: string
    meta?: Record<string, unknown>
}

export interface ToolResultEvent {
    type: 'tool_result'
    id: string
    name: string
    success: boolean
    summary: string
    data?: Record<string, unknown> | null
    error?: string | null
    duration_ms?: number | null
    artifacts: ToolArtifactRecord[]
}

export interface DoneEvent {
    type: 'done'
    status: 'ok' | 'exhausted' | 'failed'
    text: string
    final_video_url?: string | null
    final_video_path?: string | null
}

export interface ErrorEvent {
    type: 'error'
    message: string
    fatal: boolean
}

export type AgentEvent =
    | SessionEvent
    | TextEvent
    | ReasoningEvent
    | ToolCallEvent
    | ToolResultEvent
    | DoneEvent
    | ErrorEvent

/* --------- Persisted session detail (GET /api/v1/sessions/{id}) ---------- */

export interface PersistedSession {
    id: string
    problem: string
    grade: string
    status: string
    created_at: string
    updated_at: string
    final_video_path: string | null
    error: string | null
    meta: Record<string, unknown>
}

export interface PersistedMessage {
    id: number
    session_id: string
    turn_index: number
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    reasoning: string | null
    tool_calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null
    tool_call_id: string | null
    tool_name: string | null
    created_at: string
}

export interface PersistedToolCall {
    id: string
    session_id: string
    turn_index: number
    name: string
    arguments: Record<string, unknown>
    status: string
    result_summary: string | null
    result_path: string | null
    duration_ms: number | null
    error: string | null
    created_at: string
    completed_at: string | null
}

export interface PersistedArtifact {
    id: number
    session_id: string
    kind: string
    path: string
    meta: Record<string, unknown>
    created_at: string
}

export interface PersistedFeedback {
    id: number
    session_id: string
    artifact_id: number | null
    label: string
    notes: string
    created_at: string
}

export interface SessionDetail {
    session: PersistedSession
    messages: PersistedMessage[]
    tool_calls: PersistedToolCall[]
    artifacts: PersistedArtifact[]
    feedback: PersistedFeedback[]
}

/* --------- Reduced UI timeline (used by AgentTimeline) ------------------- */

export type TimelineItem =
    | { kind: 'reasoning'; key: string; text: string }
    | { kind: 'message'; key: string; text: string }
    | {
        kind: 'tool'
        key: string
        callId: string
        name: string
        arguments: Record<string, unknown>
        status: 'running' | 'success' | 'failed'
        summary?: string
        data?: Record<string, unknown> | null
        error?: string | null
        durationMs?: number | null
        artifacts: ToolArtifactRecord[]
    }

export interface AgentRunState {
    sessionId: string | null
    status: 'idle' | 'running' | 'done' | 'exhausted' | 'failed'
    items: TimelineItem[]
    finalVideoUrl: string | null
    finalText: string
    error: string | null
}
