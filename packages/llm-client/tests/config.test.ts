import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_API_BASE,
  DEFAULT_LLM_API_KEY,
  DEFAULT_LLM_MODEL,
  isLocalUrl,
  loadLlmConfig,
} from "../src/index.js";

describe("loadLlmConfig", () => {
  it("falls back to LMStudio defaults with an empty env", () => {
    const cfg = loadLlmConfig({});
    expect(cfg.main).toEqual({
      baseUrl: DEFAULT_LLM_API_BASE,
      apiKey: DEFAULT_LLM_API_KEY,
      model: DEFAULT_LLM_MODEL,
    });
    expect(cfg.main.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("reads main endpoint from engine-identical env names", () => {
    const cfg = loadLlmConfig({
      LLM_API_BASE: "http://10.0.0.5:8000/v1",
      LLM_API_KEY: "sk-test",
      LLM_MODEL: "qwen3-32b",
    });
    expect(cfg.main).toEqual({
      baseUrl: "http://10.0.0.5:8000/v1",
      apiKey: "sk-test",
      model: "qwen3-32b",
    });
  });

  it("fast/vision tiers fall back to main for every unset field", () => {
    const cfg = loadLlmConfig({
      LLM_API_BASE: "http://main:1234/v1",
      LLM_API_KEY: "main-key",
      LLM_MODEL: "main-model",
      LLM_FAST_MODEL: "qwen3-4b",
      LLM_VISION_API_BASE: "http://vision:9000/v1",
    });
    // fast: only model overridden
    expect(cfg.fast).toEqual({
      baseUrl: "http://main:1234/v1",
      apiKey: "main-key",
      model: "qwen3-4b",
    });
    expect(cfg.fastEnabled).toBe(true);
    // vision: only base overridden, model falls back to main model
    expect(cfg.vision).toEqual({
      baseUrl: "http://vision:9000/v1",
      apiKey: "main-key",
      model: "main-model",
    });
  });

  it("fastEnabled is false when LLM_FAST_MODEL is unset (resolved model = main)", () => {
    const cfg = loadLlmConfig({ LLM_MODEL: "m" });
    expect(cfg.fast.model).toBe("m");
    expect(cfg.fastEnabled).toBe(false);
  });

  it("embedding/rerank models do NOT fall back — empty means disabled", () => {
    const cfg = loadLlmConfig({ LLM_MODEL: "main-model" });
    expect(cfg.embedding.model).toBe("");
    expect(cfg.embeddingEnabled).toBe(false);
    expect(cfg.rerank.model).toBe("");
    expect(cfg.rerankEnabled).toBe(false);
    // but base/key still fall back to main
    expect(cfg.embedding.baseUrl).toBe(DEFAULT_LLM_API_BASE);
    expect(cfg.rerank.apiKey).toBe(DEFAULT_LLM_API_KEY);
  });

  it("full five-tier env round-trips with same-name variables", () => {
    const cfg = loadLlmConfig({
      LLM_API_BASE: "http://a/v1",
      LLM_API_KEY: "ka",
      LLM_MODEL: "ma",
      LLM_FAST_API_BASE: "http://b/v1",
      LLM_FAST_API_KEY: "kb",
      LLM_FAST_MODEL: "mb",
      LLM_VISION_API_BASE: "http://c/v1",
      LLM_VISION_API_KEY: "kc",
      LLM_VISION_MODEL: "mc",
      LLM_EMBEDDING_API_BASE: "http://d/v1",
      LLM_EMBEDDING_API_KEY: "kd",
      LLM_EMBEDDING_MODEL: "md",
      LLM_RERANK_API_BASE: "http://e/v1",
      LLM_RERANK_API_KEY: "ke",
      LLM_RERANK_MODEL: "me",
    });
    expect(cfg.fast).toEqual({ baseUrl: "http://b/v1", apiKey: "kb", model: "mb" });
    expect(cfg.vision).toEqual({ baseUrl: "http://c/v1", apiKey: "kc", model: "mc" });
    expect(cfg.embedding).toEqual({ baseUrl: "http://d/v1", apiKey: "kd", model: "md" });
    expect(cfg.rerank).toEqual({ baseUrl: "http://e/v1", apiKey: "ke", model: "me" });
    expect(cfg.embeddingEnabled).toBe(true);
    expect(cfg.rerankEnabled).toBe(true);
  });

  it("trims whitespace-only values and falls back (strip semantics)", () => {
    const cfg = loadLlmConfig({
      LLM_MODEL: "main-model",
      LLM_FAST_MODEL: "   ",
    });
    expect(cfg.fast.model).toBe("main-model");
    expect(cfg.fastEnabled).toBe(false);
  });
});

describe("isLocalUrl", () => {
  it.each([
    ["http://localhost:1234/v1", true],
    ["http://127.0.0.1:8000/v1", true],
    ["http://[::1]:1234/v1", true],
    ["http://0.0.0.0:1234/v1", true],
    ["http://mymac.local:1234/v1", true],
    ["http://10.1.2.3/v1", true],
    ["http://172.16.0.1/v1", true],
    ["http://172.31.255.254/v1", true],
    ["http://192.168.1.100:1234/v1", true],
    ["http://169.254.0.1/v1", true],
    ["https://api.openai.com/v1", false],
    ["http://172.32.0.1/v1", false],
    ["http://8.8.8.8/v1", false],
    ["not a url", false],
    ["", false],
  ])("%s -> %s", (url, expected) => {
    expect(isLocalUrl(url)).toBe(expected);
  });
});
