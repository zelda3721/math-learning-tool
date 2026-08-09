/**
 * SSE chunk parsing + stream-event assembly.
 *
 * `parseSseStream` turns raw SSE bytes/strings into parsed
 * chat.completion.chunk JSON payloads; `chunksToEvents` turns those chunks
 * into high-level stream events, mirroring the body of `chat_stream` in the
 * Python provider (reasoning splitting, tool-call buffering, Hermes text
 * fallback, and length-truncation promotion).
 */

import {
  ReasoningSplitter,
  extractReasoningContent,
  promoteTruncatedReasoning,
} from "./reasoning.js";
import { parseHermesToolCalls } from "./hermes.js";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface TextDelta {
  type: "text";
  text: string;
}

export interface ReasoningDelta {
  type: "reasoning";
  text: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  id: string;
  name: string;
  /** Always valid JSON of an object (defensive coercion applied). */
  argumentsJson: string;
}

export interface StreamDone {
  type: "done";
  finishReason: string;
  /** Full accumulated visible text (after any truncated-reasoning promotion). */
  text: string;
  /** Full accumulated reasoning text. */
  reasoning: string;
  toolCalls: ToolCallEvent[];
}

export type LlmStreamEvent = TextDelta | ReasoningDelta | ToolCallEvent | StreamDone;

// ---------------------------------------------------------------------------
// Wire-shape (loose) typing for chat.completion.chunk payloads
// ---------------------------------------------------------------------------

interface WireToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: WireToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// SSE line parsing
// ---------------------------------------------------------------------------

/**
 * Parse an OpenAI-style SSE stream into JSON chunk payloads.
 * Accepts an async iterable of Uint8Array or string pieces (arbitrary
 * chunking — lines may be split anywhere). Stops at `data: [DONE]`.
 * Malformed JSON data lines are skipped (tolerant).
 */
export async function* parseSseStream(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<unknown, void, undefined> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const parseLine = (line: string): { done: boolean; payload?: unknown } => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return { done: false };
    const data = trimmed.slice("data:".length).trim();
    if (!data) return { done: false };
    if (data === "[DONE]") return { done: true };
    try {
      return { done: false, payload: JSON.parse(data) as unknown };
    } catch {
      return { done: false };
    }
  };

  for await (const piece of source) {
    buffer +=
      typeof piece === "string" ? piece : decoder.decode(piece, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const { done, payload } = parseLine(line);
      if (done) return;
      if (payload !== undefined) yield payload;
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    const { done, payload } = parseLine(buffer);
    if (!done && payload !== undefined) yield payload;
  }
}

// ---------------------------------------------------------------------------
// Chunk → event assembly
// ---------------------------------------------------------------------------

/** Coerce a raw tool-call arguments string into valid JSON of an object. */
export function normalizeArgumentsJson(raw: string): string {
  if (!raw) return "{}";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return raw;
    }
    // JSON value that's not an object (e.g. '"foo"', '[1]', '42').
    return JSON.stringify({ _value: parsed });
  } catch {
    return JSON.stringify({ _raw: raw, _parse_error: true });
  }
}

/**
 * Convert parsed chat.completion.chunk payloads into LlmStreamEvents.
 * Mirrors the Python `chat_stream` loop: <think> splitting via
 * ReasoningSplitter, `reasoning_content` channel, indexed tool-call
 * accumulation, Hermes text fallback when no native tool calls appeared,
 * and truncated-reasoning promotion on finish_reason='length'.
 */
export async function* chunksToEvents(
  chunks: AsyncIterable<unknown>,
): AsyncGenerator<LlmStreamEvent, void, undefined> {
  const splitter = new ReasoningSplitter();
  const textAcc: string[] = [];
  const reasoningAcc: string[] = [];
  const tcBuf = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason = "stop";

  for await (const raw of chunks) {
    const chunk = raw as WireChunk;
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content) {
      const { visible, reasoning } = splitter.feed(delta.content);
      if (reasoning) {
        reasoningAcc.push(reasoning);
        yield { type: "reasoning", text: reasoning };
      }
      if (visible) {
        textAcc.push(visible);
        yield { type: "text", text: visible };
      }
    }

    const reasoningContent = extractReasoningContent(delta);
    if (reasoningContent) {
      reasoningAcc.push(reasoningContent);
      yield { type: "reasoning", text: reasoningContent };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const d of delta.tool_calls) {
        const idx = typeof d.index === "number" ? d.index : 0;
        let slot = tcBuf.get(idx);
        if (!slot) {
          slot = { id: "", name: "", arguments: "" };
          tcBuf.set(idx, slot);
        }
        if (d.id) slot.id = d.id;
        if (d.function?.name) slot.name = d.function.name;
        if (d.function?.arguments) slot.arguments += d.function.arguments;
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const tail = splitter.flush();
  if (tail.reasoning) {
    reasoningAcc.push(tail.reasoning);
    yield { type: "reasoning", text: tail.reasoning };
  }
  if (tail.visible) {
    textAcc.push(tail.visible);
    yield { type: "text", text: tail.visible };
  }

  const toolEvents: ToolCallEvent[] = [];
  for (const idx of [...tcBuf.keys()].sort((a, b) => a - b)) {
    const slot = tcBuf.get(idx)!;
    if (!slot.name) continue;
    const evt: ToolCallEvent = {
      type: "tool_call",
      id: slot.id || `call_${idx}`,
      name: slot.name,
      argumentsJson: normalizeArgumentsJson(slot.arguments),
    };
    toolEvents.push(evt);
    yield evt;
  }

  // Hermes / Qwen3 fallback: recover tool calls emitted as XML-like text.
  if (toolEvents.length === 0) {
    const fullTextForHermes = textAcc.join("") + reasoningAcc.join("");
    for (const call of parseHermesToolCalls(fullTextForHermes)) {
      const evt: ToolCallEvent = {
        type: "tool_call",
        id: call.id,
        name: call.name,
        argumentsJson: JSON.stringify(call.arguments),
      };
      toolEvents.push(evt);
      yield evt;
    }
  }

  const promoted = promoteTruncatedReasoning(
    finishReason,
    textAcc.join(""),
    reasoningAcc.join(""),
  );

  yield {
    type: "done",
    finishReason,
    text: promoted.text,
    reasoning: promoted.reasoning,
    toolCalls: toolEvents,
  };
}
