/**
 * ReasoningSplitter — splits incoming text into (visible, reasoning) chunks
 * based on `<think>...</think>` markers, preserving state across chunk
 * boundaries.
 *
 * Qwen3-style models emit reasoning inside these tags as part of regular
 * content when `enable_thinking` is on. We strip them out and route them to
 * the reasoning channel so the UI can show a separate "thinking" panel.
 *
 * Ported 1:1 from the Python `_ReasoningSplitter` in
 * services/video-engine/src/math_tutor/infrastructure/llm/openai_provider.py,
 * including the tail hold-back that survives tags cut across chunk
 * boundaries (e.g. "<th" + "ink>").
 */

const OPEN = "<think>";
const CLOSE = "</think>";

export interface SplitResult {
  visible: string;
  reasoning: string;
}

export class ReasoningSplitter {
  private buffer = "";
  private inThinking = false;

  /** Feed one chunk; returns the visible/reasoning text safely emittable now. */
  feed(chunk: string): SplitResult {
    this.buffer += chunk;
    const visibleParts: string[] = [];
    const reasoningParts: string[] = [];

    while (this.buffer) {
      if (this.inThinking) {
        const idx = this.buffer.indexOf(CLOSE);
        if (idx >= 0) {
          reasoningParts.push(this.buffer.slice(0, idx));
          this.buffer = this.buffer.slice(idx + CLOSE.length);
          this.inThinking = false;
          continue;
        }
        // Hold a tail in case CLOSE is split across chunks
        const hold = CLOSE.length - 1;
        if (this.buffer.length > hold) {
          reasoningParts.push(this.buffer.slice(0, -hold));
          this.buffer = this.buffer.slice(-hold);
        }
        break;
      } else {
        const idx = this.buffer.indexOf(OPEN);
        if (idx >= 0) {
          visibleParts.push(this.buffer.slice(0, idx));
          this.buffer = this.buffer.slice(idx + OPEN.length);
          this.inThinking = true;
          continue;
        }
        const hold = OPEN.length - 1;
        if (this.buffer.length > hold) {
          visibleParts.push(this.buffer.slice(0, -hold));
          this.buffer = this.buffer.slice(-hold);
        }
        break;
      }
    }

    return {
      visible: visibleParts.join(""),
      reasoning: reasoningParts.join(""),
    };
  }

  /** Drain whatever is still held back once the stream has ended. */
  flush(): SplitResult {
    const buf = this.buffer;
    this.buffer = "";
    if (!buf) return { visible: "", reasoning: "" };
    if (this.inThinking) return { visible: "", reasoning: buf };
    return { visible: buf, reasoning: "" };
  }
}

/**
 * Some providers (DeepSeek-R1 style) stream reasoning on a dedicated
 * `delta.reasoning_content` field instead of inline `<think>` tags.
 * Returns the reasoning text if present, else "".
 */
export function extractReasoningContent(delta: unknown): string {
  if (delta !== null && typeof delta === "object") {
    const rc = (delta as Record<string, unknown>)["reasoning_content"];
    if (typeof rc === "string") return rc;
  }
  return "";
}

export interface PromotionResult {
  text: string;
  reasoning: string;
  promoted: boolean;
}

/**
 * When finish_reason='length' AND visible text is empty but reasoning has
 * content, the model probably had its `<think>` block truncated by
 * max_tokens (Qwen3.5+ thinking-mode pitfall, lmstudio-bug-tracker#1559).
 * Promote the accumulated reasoning into the text channel so downstream
 * parsers have *something* to extract from.
 */
export function promoteTruncatedReasoning(
  finishReason: string,
  text: string,
  reasoning: string,
): PromotionResult {
  if (finishReason === "length" && !text.trim() && reasoning.trim()) {
    return { text: reasoning, reasoning, promoted: true };
  }
  return { text, reasoning, promoted: false };
}
