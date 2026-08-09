/**
 * Minimal SSE client over fetch + ReadableStream.
 *
 * `EventSource` doesn't support POST bodies, so we roll our own. Yields
 * `{event, data}` objects parsed from the standard SSE frame format
 * (`event: ...\ndata: ...\n\n`).
 */

export interface SSEMessage<T = unknown> {
    event: string
    data: T
}

export interface SSEPostOptions {
    signal?: AbortSignal
    headers?: Record<string, string>
}

export async function* postSSE<T = unknown>(
    url: string,
    body: unknown,
    options: SSEPostOptions = {}
): AsyncGenerator<SSEMessage<T>> {
    const response = await fetch(url, {
        method: 'POST',
        signal: options.signal,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...options.headers,
        },
        body: JSON.stringify(body),
    })

    if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '')
        throw new Error(
            `SSE request failed: ${response.status} ${response.statusText} ${text}`.trim()
        )
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            let separatorIdx: number
            while ((separatorIdx = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, separatorIdx)
                buffer = buffer.slice(separatorIdx + 2)
                const message = parseFrame<T>(block)
                if (message) yield message
            }
        }

        // Flush any trailing frame without a terminating blank line
        const tail = buffer.trim()
        if (tail) {
            const message = parseFrame<T>(tail)
            if (message) yield message
        }
    } finally {
        reader.releaseLock()
    }
}

function parseFrame<T>(block: string): SSEMessage<T> | null {
    let event = 'message'
    const dataLines: string[] = []
    for (const rawLine of block.split('\n')) {
        const line = rawLine.replace(/\r$/, '')
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) {
            event = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim())
        }
        // Ignore other fields (id:, retry:) — we don't use them yet.
    }
    if (dataLines.length === 0) return null
    const dataText = dataLines.join('\n')
    try {
        return { event, data: JSON.parse(dataText) as T }
    } catch (err) {
        console.warn('SSE: failed to parse data as JSON', dataText, err)
        return null
    }
}
