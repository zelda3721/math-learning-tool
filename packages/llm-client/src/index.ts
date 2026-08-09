export {
  ReasoningSplitter,
  extractReasoningContent,
  promoteTruncatedReasoning,
  type SplitResult,
  type PromotionResult,
} from "./reasoning.js";

export { parseHermesToolCalls, type HermesToolCall } from "./hermes.js";

export {
  loadLlmConfig,
  isLocalUrl,
  DEFAULT_LLM_API_BASE,
  DEFAULT_LLM_API_KEY,
  DEFAULT_LLM_MODEL,
  type LlmConfig,
  type LlmEndpointConfig,
} from "./config.js";

export {
  parseSseStream,
  chunksToEvents,
  normalizeArgumentsJson,
  type LlmStreamEvent,
  type TextDelta,
  type ReasoningDelta,
  type ToolCallEvent,
  type StreamDone,
} from "./stream.js";

export {
  LlmClient,
  LlmHttpError,
  type LlmClientInit,
  type ChatMessage,
  type ChatRole,
  type ChatToolCall,
  type ChatOptions,
  type ToolDefinition,
} from "./client.js";
