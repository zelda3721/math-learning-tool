/**
 * Five-tier layered LLM endpoint configuration.
 *
 * Env variable names are byte-identical to the Python engine's
 * `config/settings.py` (pydantic BaseSettings uppercases field names):
 *
 *   main:      LLM_API_BASE / LLM_MODEL / LLM_API_KEY
 *   fast:      LLM_FAST_API_BASE / LLM_FAST_MODEL / LLM_FAST_API_KEY
 *   vision:    LLM_VISION_API_BASE / LLM_VISION_MODEL / LLM_VISION_API_KEY
 *   embedding: LLM_EMBEDDING_API_BASE / LLM_EMBEDDING_MODEL / LLM_EMBEDDING_API_KEY
 *   rerank:    LLM_RERANK_API_BASE / LLM_RERANK_MODEL / LLM_RERANK_API_KEY
 *
 * Fallback semantics mirror the engine's `resolved_*` properties:
 * - baseUrl / apiKey always fall back to main.
 * - fast / vision model falls back to the main model.
 * - embedding / rerank model does NOT fall back — empty string means the
 *   tier is disabled (see `resolved_embedding_model` / `resolved_rerank_model`).
 */

export interface LlmEndpointConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface LlmConfig {
  main: LlmEndpointConfig;
  fast: LlmEndpointConfig;
  vision: LlmEndpointConfig;
  embedding: LlmEndpointConfig;
  rerank: LlmEndpointConfig;
  /** True when a dedicated fast model is configured (LLM_FAST_MODEL non-empty). */
  fastEnabled: boolean;
  /** True when an embedding model is configured. */
  embeddingEnabled: boolean;
  /** True when a rerank model is configured. */
  rerankEnabled: boolean;
}

// Defaults target LMStudio + Qwen3, same as settings.py.
export const DEFAULT_LLM_API_BASE = "http://localhost:1234/v1";
export const DEFAULT_LLM_API_KEY = "lm-studio";
export const DEFAULT_LLM_MODEL = "qwen3.6-35b-a3b";

type Env = Record<string, string | undefined>;

export function loadLlmConfig(env: Env = process.env): LlmConfig {
  const pick = (key: string): string => (env[key] ?? "").trim();

  const main: LlmEndpointConfig = {
    baseUrl: pick("LLM_API_BASE") || DEFAULT_LLM_API_BASE,
    apiKey: pick("LLM_API_KEY") || DEFAULT_LLM_API_KEY,
    model: pick("LLM_MODEL") || DEFAULT_LLM_MODEL,
  };

  const tier = (prefix: string, modelFallback: string): LlmEndpointConfig => ({
    baseUrl: pick(`${prefix}_API_BASE`) || main.baseUrl,
    apiKey: pick(`${prefix}_API_KEY`) || main.apiKey,
    model: pick(`${prefix}_MODEL`) || modelFallback,
  });

  const fast = tier("LLM_FAST", main.model);
  const vision = tier("LLM_VISION", main.model);
  // Empty model == tier disabled (no fallback), matching resolved_* semantics.
  const embedding = tier("LLM_EMBEDDING", "");
  const rerank = tier("LLM_RERANK", "");

  return {
    main,
    fast,
    vision,
    embedding,
    rerank,
    fastEnabled: Boolean(pick("LLM_FAST_MODEL")),
    embeddingEnabled: Boolean(embedding.model),
    rerankEnabled: Boolean(rerank.model),
  };
}

/**
 * Return true for loopback, LAN, and mDNS model endpoints.
 * Ported from `_is_local_url` in openai_provider.py.
 */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  // Node keeps IPv6 hosts bracketed in URL.hostname.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return true;
  }
  if (host.endsWith(".local")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const octets = v4.slice(1).map(Number) as [number, number, number, number];
    if (octets.some((o) => o > 255)) return false;
    const [a, b] = octets;
    return (
      a === 127 || // loopback
      a === 10 || // private 10/8
      (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
      (a === 192 && b === 168) || // private 192.168/16
      (a === 169 && b === 254) // link-local
    );
  }

  if (host.includes(":")) {
    // IPv6: unique-local fc00::/7 and link-local fe80::/10
    const head = host.split(":", 1)[0] ?? "";
    if (head.startsWith("fc") || head.startsWith("fd")) return true;
    if (
      head.startsWith("fe8") ||
      head.startsWith("fe9") ||
      head.startsWith("fea") ||
      head.startsWith("feb")
    ) {
      return true;
    }
  }

  return false;
}
