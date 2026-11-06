import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalOnlyViolationError, loadLlmConfig } from "@mathtutor/llm-client";
import { appendLlmAudit, auditDataDir, createServerLlmClient, LLM_AUDIT_FILE, readLlmAudit } from "../src/llm.js";

/**
 * LOCAL_ONLY 是 D5 的硬约束：默认只许本地端点，放行云端必须显式关掉且留审计。
 * 这里验的是**服务端装配层**——真正发请求的拦截在 packages/llm-client 里。
 */

describe("服务端 LLM 客户端装配", () => {
  it("LOCAL_ONLY 开着时，云端端点连构造都不行", () => {
    const config = loadLlmConfig({ LLM_API_BASE: "https://api.example.com/v1", LOCAL_ONLY: "1" });
    expect(() => createServerLlmClient(config, "main")).toThrow(LocalOnlyViolationError);
  });

  it("显式 LOCAL_ONLY=0 才放行", () => {
    const config = loadLlmConfig({ LLM_API_BASE: "https://api.example.com/v1", LOCAL_ONLY: "0" });
    expect(() => createServerLlmClient(config, "main")).not.toThrow();
  });

  it("本地端点在任何设置下都能用（默认配置就是本地）", () => {
    const config = loadLlmConfig({ LLM_API_BASE: "http://127.0.0.1:8888/v1" });
    expect(config.localOnly).toBe(true);
    expect(() => createServerLlmClient(config, "main")).not.toThrow();
  });
});

describe("云端调用审计", () => {
  it("越界调用在 <DATA_DIR>/llm-audit.jsonl 留一行，且不含 apiKey", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "llm-audit-"));
    appendLlmAudit(dataDir, { at: "2026-11-06T12:00:00.000Z", baseUrl: "https://api.example.com/v1", model: "cloud" });

    const raw = readFileSync(path.join(dataDir, LLM_AUDIT_FILE), "utf8").trim().split("\n");
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0]!)).toEqual({
      at: "2026-11-06T12:00:00.000Z",
      baseUrl: "https://api.example.com/v1",
      model: "cloud",
    });
    expect(raw[0]).not.toContain("sk-");
  });

  it("读回最近的审计行；文件不存在时给空数组，不炸", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "llm-audit-"));
    expect(readLlmAudit(dataDir)).toEqual([]);

    appendLlmAudit(dataDir, { at: "t1", baseUrl: "https://a/v1", model: "m" });
    appendLlmAudit(dataDir, { at: "t2", baseUrl: "https://b/v1", model: "m" });
    expect(readLlmAudit(dataDir).map((e) => e.at)).toEqual(["t1", "t2"]);
    expect(readLlmAudit(dataDir, 1).map((e) => e.at)).toEqual(["t2"]);
  });

  it("审计写盘失败不影响请求（旁路不能成为关键路径）", () => {
    // 指向一个必然写不进去的位置：/dev/null 下面不能再建目录
    expect(() => appendLlmAudit("/dev/null/nope", { at: "t", baseUrl: "https://a/v1", model: "m" })).not.toThrow();
  });
});

describe("auditDataDir", () => {
  it("没写 DATA_DIR 时落在仓库根的 data/", () => {
    expect(auditDataDir({})).toMatch(/\/data\/?$/);
  });

  it("写了就按仓库根解析（和 config 的 DATA_DIR 同口径）", () => {
    expect(auditDataDir({ DATA_DIR: "./data" })).toMatch(/\/data\/?$/);
    expect(auditDataDir({ DATA_DIR: "./tmp-x" })).toMatch(/\/tmp-x\/?$/);
  });
});
