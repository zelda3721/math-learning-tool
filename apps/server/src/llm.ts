import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  LlmClient,
  isLocalUrl,
  type LlmAuditEvent,
  type LlmClientInit,
  type LlmConfig,
} from "@mathtutor/llm-client";

/**
 * 服务端造 LLM 客户端的**唯一入口**。
 *
 * 为什么不让各处自己 `new LlmClient`：LOCAL_ONLY 是硬约束（D5），
 * 而"每处自己记得传 localOnly 和审计"这种约定，加第十个调用点时必然漏掉一个。
 * 收成一个函数之后，漏掉的方式只剩"绕开这个文件"，而那在 review 里看得见。
 */

export type LlmTier = "main" | "fast" | "vision" | "embedding" | "rerank";

export interface ServerLlmOptions
  extends Omit<LlmClientInit, "baseUrl" | "apiKey" | "model" | "localOnly" | "audit"> {
  /** 审计文件所在的数据根；省略则不落审计（单测/脚本） */
  dataDir?: string;
}

/** 审计文件名：`<DATA_DIR>/llm-audit.jsonl`，一行一次越界请求 */
export const LLM_AUDIT_FILE = "llm-audit.jsonl";

/**
 * 审计数据根：与 config.ts 解析 DATA_DIR 的口径一致（相对仓库根），
 * 免得审计写到和 data/ 并列的另一个目录里去。
 */
export function auditDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATA_DIR
    ? path.resolve(new URL("../../../", import.meta.url).pathname, env.DATA_DIR)
    : new URL("../../../data", import.meta.url).pathname;
}

/**
 * 越界请求追加一行 JSONL。
 *
 * 只记时间、端点、模型——**绝不记 apiKey 和消息内容**：审计表本身变成新的泄露面
 * 是最讽刺的失败。写盘失败也绝不让请求失败：审计是旁路，不是关键路径。
 */
export function appendLlmAudit(dataDir: string, event: LlmAuditEvent): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(path.join(dataDir, LLM_AUDIT_FILE), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // 旁路失败不影响主流程
  }
}

export function readLlmAudit(dataDir: string, limit = 100): LlmAuditEvent[] {
  try {
    const file = path.join(dataDir, LLM_AUDIT_FILE);
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LlmAuditEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function createServerLlmClient(
  config: LlmConfig,
  tier: LlmTier,
  options: ServerLlmOptions = {},
): LlmClient {
  const endpoint = config[tier];
  const { dataDir, ...rest } = options;
  return new LlmClient({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model,
    localOnly: config.localOnly,
    audit: dataDir ? (event) => appendLlmAudit(dataDir, event) : undefined,
    ...rest,
  });
}

/** 端点局部性判断（家长中心展示"这次走的是本地还是云"） */
export function endpointIsLocal(baseUrl: string): boolean {
  return isLocalUrl(baseUrl);
}
