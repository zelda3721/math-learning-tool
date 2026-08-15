import type { SceneAction } from "@mathtutor/schema";

/** 引擎图元词表（validate 里未知图元 → warning，player 里未知图元走兜底盒） */
export const KNOWN_PRIMITIVES = new Set([
  "dot",
  "circle",
  "rectangle",
  "line",
  "function_curve",
  "arrow",
  "quantity_bar",
  "unit_grid",
  "number_line",
  "axes",
  "polygon",
  "relation_node",
  "balance",
  // 讲义原图的转写重画（引擎注入坐标；播放器走保形的 figure 渲染器）
  "figure",
]);

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
