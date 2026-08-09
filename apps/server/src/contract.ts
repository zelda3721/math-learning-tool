import { EngineContractSchema, type EngineContract } from "@mathtutor/schema";

export class ContractError extends Error {}

/**
 * 启动时拉取引擎契约并校验（设计 §05：校验失败拒绝启动，而不是静默失真）。
 * 引擎离线且 allowOffline 时返回 null（开发降级：atlas 可用、讲解不可用）。
 */
export async function fetchEngineContract(
  engineUrl: string,
  allowOffline: boolean,
): Promise<EngineContract | null> {
  let resp: Response;
  try {
    resp = await fetch(`${engineUrl}/api/v1/contract`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    if (allowOffline) {
      console.warn(`[contract] 引擎不可达（${engineUrl}），ALLOW_ENGINE_OFFLINE=1 降级启动：讲解功能不可用`);
      return null;
    }
    throw new ContractError(`引擎不可达：${engineUrl}（${String(err)}）。设 ALLOW_ENGINE_OFFLINE=1 可降级启动`);
  }
  if (!resp.ok) {
    throw new ContractError(`引擎契约端点返回 ${resp.status}——引擎版本过旧（缺 /api/v1/contract）？`);
  }
  const parsed = EngineContractSchema.safeParse(await resp.json());
  if (!parsed.success) {
    throw new ContractError(`引擎契约 schema 校验失败，拒绝启动：${parsed.error.message}`);
  }
  const contract = parsed.data;
  if (!contract.contract_version.startsWith("open_world_v4")) {
    throw new ContractError(
      `引擎契约版本不兼容：期望 open_world_v4*，实际 ${contract.contract_version}，拒绝启动`,
    );
  }
  return contract;
}
