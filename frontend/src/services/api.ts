/**
 * API Service - Handles all backend API calls
 */

const API_BASE = '/api/v1';

export interface Grade {
    level: string;
    display_name: string;
    thinking_style: string;
    visualization_style: string;
}

export interface ProcessProblemRequest {
    problem: string;
    grade: string;
}

export interface ProcessProblemResponse {
    status: string;
    problem: string;
    grade: string;
    analysis?: {
        problem_type?: string;
        concepts?: string[];
        difficulty?: string;
        strategy?: string;
    };
    solution?: {
        strategy?: string;
        steps?: Array<{
            step_number: number;
            description: string;
            operation: string;
        }>;
        answer?: string;
    };
    visualization_code?: string;
    video_url?: string;
    error?: string;
}

class ApiService {
    private async fetch<T>(
        endpoint: string,
        options?: RequestInit
    ): Promise<T> {
        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options?.headers,
            },
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.statusText}`);
        }

        return response.json();
    }

    async getGrades(): Promise<Grade[]> {
        return this.fetch<Grade[]>('/grades');
    }

    async processProblem(
        request: ProcessProblemRequest
    ): Promise<ProcessProblemResponse> {
        return this.fetch<ProcessProblemResponse>('/problems/process', {
            method: 'POST',
            body: JSON.stringify(request),
        });
    }

    async healthCheck(): Promise<{ status: string }> {
        const response = await fetch('/api/health');
        return response.json();
    }
}

export const api = new ApiService();
