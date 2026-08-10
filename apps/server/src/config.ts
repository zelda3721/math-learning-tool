import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 读仓库根 .env 注入 process.env（已存在的真实环境变量优先，不覆盖）。
 * 与引擎共享同一份 .env：SERVER_PORT/SERVER_HOST/ENGINE_URL/DATA_DIR/
 * ALLOW_ENGINE_OFFLINE 以及 LLM_*（提示/抽题/拍照判卷）都可以写在里面。
 */
export function applyDotEnv(
  envPath: string = new URL("../../../.env", import.meta.url).pathname,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (env[key] !== undefined) continue; // 真实环境变量优先
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

export interface ServerConfig {
  /** server 监听端口（对外唯一入口；平板经局域网访问） */
  port: number;
  /** 监听地址：默认 0.0.0.0 以支持局域网/平板访问 */
  host: string;
  /** Python 讲解引擎地址（内网，学生设备永不直连） */
  engineUrl: string;
  /** data/ 唯一数据根 */
  dataDir: string;
  /** 引擎离线时是否允许降级启动（开发用；生产按设计应拒绝启动） */
  allowEngineOffline: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.SERVER_PORT ?? 8080),
    host: env.SERVER_HOST ?? "0.0.0.0",
    engineUrl: (env.ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, ""),
    // 相对 DATA_DIR 锚定仓库根（共享 .env 里的 ./data：引擎解析到引擎根、网关解析到仓库根，各取各的存储）
    dataDir: env.DATA_DIR
      ? path.resolve(new URL("../../..", import.meta.url).pathname, env.DATA_DIR)
      : new URL("../../../data", import.meta.url).pathname,
    allowEngineOffline: env.ALLOW_ENGINE_OFFLINE === "1",
  };
}
