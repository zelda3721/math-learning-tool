import { foldBeats, gateBeats, type SemanticFinding } from "@mathtutor/explainer-web";
import type { SceneSpec } from "@mathtutor/schema";

/**
 * 生成端的语义门禁。
 *
 * 播放器里也跑同一套检查，但那里是**孩子点了播放之后**才提示——太晚了：
 * 讲解已经生成、已经入库、已经推到屏幕上。这一层要的是**产出时**就把它标出来，
 * 让质量分级（good / acceptable）说实话，出问题时也能在日志里查到是哪一条。
 *
 * 三条反例见 `packages/explainer-web/src/gate.ts`：宣称的数量对不上、
 * 写了搬运却没搬、清点一个空组。它们都对应真实事故，不是理论边界。
 */

/**
 * 对一份 SceneSpec 跑语义门禁。
 *
 * 门禁本身出问题（spec 结构怪、折叠抛错）时返回空数组并打日志：
 * 这是**质量信号**，不是安全闸门——它挂了不该让孩子的讲解断掉。
 */
export function semanticFindingsOf(spec: SceneSpec): SemanticFinding[] {
  try {
    return gateBeats(foldBeats(spec), spec as unknown as { scenes?: { actions?: { op?: string }[] }[] });
  } catch (err) {
    console.warn(`[explain] 语义门禁执行失败（不影响交付）：${String(err)}`);
    return [];
  }
}

/**
 * 质量分级：结构问题或语义问题任一存在就降到 acceptable。
 *
 * 为什么不是"有问题就拒收"：讲解的价值是孩子此刻能看懂，而一张没画全的图
 * 仍可能比"No content"强。但**必须降级**——把有问题的那份标成 good，
 * 等于告诉后台"这条不用再看"，而它恰恰是唯一需要有人看的那些。
 */
export function qualityOf(
  structuralWarnings: string[],
  findings: SemanticFinding[],
): "good" | "acceptable" {
  return structuralWarnings.length > 0 || findings.length > 0 ? "acceptable" : "good";
}
