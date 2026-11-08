import { defaultVisuals } from "./visuals.js";
import type { SceneAction } from "@mathtutor/schema";

/** 引擎图元词表（validate 里未知图元 → warning，player 里未知图元走兜底盒） */
/**
 * 已知图元 = 视觉词表里声明过的那些。
 *
 * 从注册表**派生**而不是另抄一份：抄一份的下场是加了新图元、校验器还在报警告，
 * 而警告看多了就没人看了。
 */
export const KNOWN_PRIMITIVES = new Set(defaultVisuals.list().map((d) => d.primitive));

/** 引擎常见动作 op（未知 op → warning，折叠时忽略但保持可见性） */
export const KNOWN_OPS = new Set([
  "appear",
  "take_from",
  "combine",
  "partition_into",
  "replicate",
  "count",
  "recount_verify",
  "move",
  "highlight",
  "reveal",
  "transform",
  "set_value",
]);

/**
 * action 中约定俗成的对象引用键。刻意不含 to/from（可能是坐标/位置语义），
 * 宽容收集：值为 string 或 string[] 都接受。
 */
const REF_KEYS = [
  "target",
  "targets",
  "object",
  "objects",
  "source",
  "sources",
  "id",
  "ids",
  "into",
  "with",
] as const;

/** 从一个 action 里收集它引用的对象 id 列表（去重、保持出现顺序） */
export function collectRefs(action: SceneAction): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0 && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  const rec = action as Record<string, unknown>;
  for (const key of REF_KEYS) {
    const v = rec[key];
    if (Array.isArray(v)) for (const item of v) push(item);
    else push(v);
  }
  return out;
}

/** 宽容取数：非有限数值一律用默认值 */
export function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
