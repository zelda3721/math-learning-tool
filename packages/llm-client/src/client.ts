/**
 * LlmClient — OpenAI-compatible streaming chat client over global fetch.
 *
 * Zero runtime dependencies. Ported from `OpenAILLMProvider` in the Python
 * engine: exponential-backoff retry on transient errors (429/5xx/network),
 * <think> reasoning splitting, native tool-call assembly, Hermes text
 * fallback, and truncated-reasoning promotion — all via stream.ts.
 */

import type { LlmEndpointConfig } from "./config.js";
import {
  chunksToEvents,
  parseSseStream,
  type LlmStreamEvent,
} from "./stream.js";

// ---------------------------------------------------------------------------
// Message / tool types
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ChatMessage {
  role: ChatRole;
  /** Plain string or multimodal parts array; null becomes "". */
  content: string | Array<Record<string, unknown>> | null;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  /** Extra top-level body fields (e.g. chat_template_kwargs). */
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface LlmClientInit {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Default extra body merged into every request. */
  extraBody?: Record<string, unknown>;
  /**
   * When tools are present, force chat_template_kwargs.enable_thinking=false
   * unless explicitly set — Qwen3-style models otherwise burn tokens thinking
   * before tool_calls (or wedge the LMStudio template renderer). Default true.
   */
  disableThinkingWithTools?: boolean;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests. Defaults to real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export class LlmHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`LLM request failed with status ${status}: ${body.slice(0, 240)}`);
    this.name = "LlmHttpError";
    this.status = status;
    this.body = body;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number): boolean {
  // Mirrors Python _RETRYABLE: InternalServerError (>=500) + RateLimitError
  // (429). 502/503 are the common LMStudio "model loading / proxy" cases.
  return status === 429 || status >= 500;
}

async function* iterateBody(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array, void, undefined> {
  if (!body) return;
  const iterable = body as unknown as Partial<AsyncIterable<Uint8Array>>;
  if (typeof iterable[Symbol.asyncIterator] === "function") {
    yield* iterable as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export class LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly maxRetries: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly extraBody: Record<string, unknown>;
  private readonly disableThinkingWithTools: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(init: LlmClientInit) {
    this.baseUrl = init.baseUrl.replace(/\/+$/, "");
    this.apiKey = init.apiKey || "lm-studio";
    this.model = init.model;
    this.temperature = init.temperature ?? 0.6;
    this.maxTokens = init.maxTokens ?? 8192;
    this.maxRetries = Math.max(0, init.maxRetries ?? 3);
    this.retryInitialDelayMs = init.retryInitialDelayMs ?? 1000;
    this.retryMaxDelayMs = init.retryMaxDelayMs ?? 8000;
    this.extraBody = init.extraBody ?? {};
    this.disableThinkingWithTools = init.disableThinkingWithTools ?? true;
    this.fetchFn = init.fetch ?? globalThis.fetch;
    this.sleep = init.sleep ?? defaultSleep;
  }

  static fromEndpoint(
    endpoint: LlmEndpointConfig,
    extra: Omit<LlmClientInit, "baseUrl" | "apiKey" | "model"> = {},
  ): LlmClient {
    return new LlmClient({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      ...extra,
    });
  }

  /**
   * Streaming chat completion. Yields TextDelta / ReasoningDelta /
   * ToolCallEvent events and a final StreamDone (always last).
   */
  async *chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): AsyncGenerator<LlmStreamEvent, void, undefined> {
    const payload = this.buildPayload(messages, opts);
    const response = await this.requestWithRetry(payload, opts.signal);
    yield* chunksToEvents(parseSseStream(iterateBody(response.body)));
  }

  private buildPayload(
    messages: ChatMessage[],
    opts: ChatOptions,
  ): Record<string, unknown> {
    const mergedExtra: Record<string, unknown> = {
      ...this.extraBody,
      ...(opts.extraBody ?? {}),
    };

    const tools = opts.tools ?? [];
    if (tools.length > 0 && this.disableThinkingWithTools) {
      const ctk = {
        ...((mergedExtra["chat_template_kwargs"] as
          | Record<string, unknown>
          | undefined) ?? {}),
      };
      if (!("enable_thinking" in ctk)) {
        ctk["enable_thinking"] = false;
        mergedExtra["chat_template_kwargs"] = ctk;
      }
    }

    const payload: Record<string, unknown> = {
      ...mergedExtra,
      model: opts.model || this.model,
      messages: messages.map(toWireMessage),
      temperature: opts.temperature ?? this.temperature,
      max_tokens: opts.maxTokens ?? this.maxTokens,
      stream: true,
    };
    if (tools.length > 0) {
      payload["tools"] = tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: t.parameters ?? { type: "object", properties: {} },
        },
      }));
      payload["tool_choice"] = "auto";
      payload["parallel_tool_calls"] = true;
    }
    return payload;
  }

  private async requestWithRetry(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let delay = this.retryInitialDelayMs;
    let lastError: unknown = new Error("LLM call failed without an exception");

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response | null = null;
      try {
        response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal,
        });
      } catch (err) {
        // Aborts are intentional — never retry them.
        if (signal?.aborted) throw err;
        lastError = err; // network error → retryable
      }

      if (response) {
        if (response.ok) return response;
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch {
          /* body unavailable */
        }
        const httpError = new LlmHttpError(response.status, bodyText);
        if (!isRetryableStatus(response.status)) throw httpError;
        lastError = httpError;
      }

      if (attempt >= this.maxRetries) throw lastError;
      await this.sleep(delay);
      delay = Math.min(delay * 2, this.retryMaxDelayMs);
    }
    throw lastError; // defensive — unreachable
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  const d: Record<string, unknown> = {
    role: m.role,
    // OpenAI requires content present (may be "") when tool_calls are set.
    content: m.content ?? "",
  };
  if (m.toolCalls && m.toolCalls.length > 0) {
    d["tool_calls"] = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.argumentsJson },
    }));
  }
  if (m.toolCallId) d["tool_call_id"] = m.toolCallId;
  if (m.name && m.role === "tool") d["name"] = m.name;
  return d;
}
