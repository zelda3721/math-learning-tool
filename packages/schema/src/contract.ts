import { z } from "zod";

/**
 * 引擎契约（GET /api/v1/contract）：TS 侧与 Python 引擎之间唯一的、有 schema 校验的合同。
 * server 启动时拉取校验，major 版本不符拒绝启动（设计 §05 / R3）。
 */
export const EngineToolMetaSchema = z.object({
  name: z.string(),
  label_zh: z.string(),
  stage: z.string(),
  palette: z.string(),
});
export type EngineToolMeta = z.infer<typeof EngineToolMetaSchema>;

export const EngineContractSchema = z
  .object({
    contract_version: z.string(),
    tools: z.array(EngineToolMetaSchema),
    event_types: z.array(z.string()),
    artifact_url_base: z.string(),
  })
  .passthrough();
export type EngineContract = z.infer<typeof EngineContractSchema>;
