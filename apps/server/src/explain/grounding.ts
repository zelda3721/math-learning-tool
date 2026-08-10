/**
 * 讲解画面是谁设计的。
 *
 * 引擎里画面计划有四道顺位：9 个确定性构造器（从已验证的 Math IR 认结构）→
 * LLM 视觉导演 → 安全基线 → 最小叙事。确定性那一档会在计划上盖 `grounding_source`
 * 的章（linear_mix_swap / quantity_story / derivative…），模型写的计划没有这个字段。
 *
 * 记这一笔是为了能回答一个此前问不了的问题：画质波动到底来自哪条路径。
 * 同一道鸡兔同笼，走构造器时是「圆圈各垂 2 根线」的确定性画面（成片审查 12/12），
 * 掉到模型路径时就换了一套表达——事后无从分辨，就只能凭感觉调。
 */
export function groundingSourceOf(spec: unknown): string | undefined {
  if (typeof spec !== "object" || spec === null) return undefined;
  const value = (spec as Record<string, unknown>).grounding_source;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
