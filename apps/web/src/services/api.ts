/**
 * API Service - Handles all backend API calls
 */

import type { SessionDetail, PersistedSession } from '../types/agent'

const API_BASE = '/api/v1'

export interface Grade {
    level: string
    display_name: string
    thinking_style: string
    visualization_style: string
    example_problem: string
}

export interface ProcessProblemRequest {
    problem: string
    grade: string
}

export interface ProcessProblemResponse {
    status: string
    problem: string
    grade: string
    session_id?: string
    analysis?: {
        problem_type?: string
        concepts?: string[]
        difficulty?: string
        strategy?: string
    }
    solution?: {
        strategy?: string
        steps?: Array<{
            step_number: number
            description: string
            operation: string
        }>
        answer?: string
    }
    visualization_code?: string
    video_url?: string
    error?: string
}

export interface FeedbackRequest {
    label: 'good' | 'bad' | 'neutral'
    notes?: string
    artifact_id?: number | null
}

export interface PromoteExampleRequest {
    label: 'good' | 'bad'
    tags?: string[]
    notes?: string
}

class ApiService {
    private async fetchJson<T>(endpoint: string, options?: RequestInit): Promise<T> {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
            },
        })

        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(`API Error ${response.status}: ${text || response.statusText}`)
        }

        return response.json() as Promise<T>
    }

    chatStreamUrl(): string {
        return `${API_BASE}/chat`
    }

    async getGrades(): Promise<Grade[]> {
        return this.fetchJson<Grade[]>('/grades')
    }

    async processProblem(request: ProcessProblemRequest): Promise<ProcessProblemResponse> {
        return this.fetchJson<ProcessProblemResponse>('/problems/process', {
            method: 'POST',
            body: JSON.stringify(request),
        })
    }

    async listSessions(opts: { limit?: number; offset?: number; label?: string } = {}): Promise<PersistedSession[]> {
        const params = new URLSearchParams()
        if (opts.limit !== undefined) params.set('limit', String(opts.limit))
        if (opts.offset !== undefined) params.set('offset', String(opts.offset))
        if (opts.label) params.set('label', opts.label)
        const qs = params.toString()
        return this.fetchJson<PersistedSession[]>(`/sessions${qs ? `?${qs}` : ''}`)
    }

    async getSession(sessionId: string): Promise<SessionDetail> {
        return this.fetchJson<SessionDetail>(`/sessions/${sessionId}`)
    }

    async deleteSession(sessionId: string): Promise<{
        deleted: boolean
        archive_dir_removed?: boolean
        videos_removed_count?: number
        artifacts_count?: number
    }> {
        return this.fetchJson(`/sessions/${sessionId}`, { method: 'DELETE' })
    }

    async submitFeedback(sessionId: string, body: FeedbackRequest): Promise<{ id: number }> {
        return this.fetchJson<{ id: number }>(`/sessions/${sessionId}/feedback`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    }

    async promoteExample(sessionId: string, body: PromoteExampleRequest): Promise<{ id: number }> {
        return this.fetchJson<{ id: number }>(`/sessions/${sessionId}/promote_example`, {
            method: 'POST',
            body: JSON.stringify(body),
        })
    }

    async healthCheck(): Promise<{ status: string }> {
        const response = await fetch('/api/health')
        return response.json()
    }
}

export const api = new ApiService()
