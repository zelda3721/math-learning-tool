import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyDotEnv } from "../src/config.js";

describe("applyDotEnv", () => {
  it("loads keys, respects existing env, strips quotes/comments", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mathtutor-env-"));
    const file = path.join(dir, ".env");
    writeFileSync(
      file,
      [
        "# 注释行",
        "SERVER_PORT=9090",
        'ENGINE_URL="http://127.0.0.1:8000"',
        "LLM_MODEL='qwen/qwen3.6-27b'",
        "ALREADY_SET=from-file",
        "",
        "无等号的坏行",
      ].join("\n"),
      "utf8",
    );
    const env: NodeJS.ProcessEnv = { ALREADY_SET: "from-real-env" };
    applyDotEnv(file, env);
    expect(env.SERVER_PORT).toBe("9090");
    expect(env.ENGINE_URL).toBe("http://127.0.0.1:8000");
    expect(env.LLM_MODEL).toBe("qwen/qwen3.6-27b");
    expect(env.ALREADY_SET).toBe("from-real-env"); // 真实环境变量优先
  });

  it("missing file is a no-op", () => {
    const env: NodeJS.ProcessEnv = {};
    applyDotEnv("/nonexistent/.env", env);
    expect(Object.keys(env)).toEqual([]);
  });
});
