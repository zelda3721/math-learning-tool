import { SceneSpecSchema, type SceneSpec } from "@mathtutor/schema";
import { KNOWN_OPS, KNOWN_PRIMITIVES, collectRefs } from "./refs.js";

export interface ValidateResult {
  /** errors 非空时为 null——有 error 的 spec 不应被播放 */
  spec: SceneSpec | null;
  errors: string[];
  warnings: string[];
}

/**
 * SceneSpec 校验：先过 @mathtutor/schema 的 SceneSpecSchema，再做结构检查。
 * - errors（拒绝播放）：schema 不合法、对象 id 重复、action 引用不存在的对象 id
 * - warnings（宽容放行）：未知 primitive、未知 op
 */
export function validateSpec(
  raw: unknown,
  /** 视觉词表：学科新增图元要从这里传，否则会被当成未知图元报警告 */
  visuals: { has(primitive: string): boolean } = { has: (p) => KNOWN_PRIMITIVES.has(p) },
): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const parsed = SceneSpecSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      errors.push(`schema: ${path}: ${issue.message}`);
    }
    return { spec: null, errors, warnings };
  }

  const spec = parsed.data;
  const ids = new Set<string>();
  const primitiveById = new Map<string, string>();
  for (const obj of spec.visual_objects) {
    if (ids.has(obj.id)) errors.push(`duplicate object id: "${obj.id}"`);
    ids.add(obj.id);
    primitiveById.set(obj.id, obj.primitive);
    if (!visuals.has(obj.primitive)) {
      warnings.push(`unknown primitive "${obj.primitive}" on object "${obj.id}"`);
    }
  }

  spec.scenes.forEach((beat, beatIndex) => {
    beat.actions.forEach((action, actionIndex) => {
      if (!KNOWN_OPS.has(action.op)) {
        warnings.push(`unknown op "${action.op}" at scenes[${beatIndex}].actions[${actionIndex}]`);
      }
      /*
       * set_value 只对「量」生效。写在一个可数记号组上，这条动作什么都不会改——
       * 静默无效比报错更难查：谱子看着没问题，画面就是不动。
       * 这里静态地提醒一句（不拦，因为宽容放行是本校验的一贯做法）。
       */
      if (action.op === "set_value") {
        for (const ref of collectRefs(action)) {
          const prim = primitiveById.get(ref);
          if (prim !== undefined && prim !== "quantity_bar") {
            warnings.push(
              `set_value 只对量（quantity_bar）生效；对象 "${ref}" 是 "${prim}"，这条动作不会改变任何东西`,
            );
          }
        }
      }
      for (const ref of collectRefs(action)) {
        if (!ids.has(ref)) {
          errors.push(
            `scenes[${beatIndex}].actions[${actionIndex}] (op "${action.op}") references unknown object id: "${ref}"`,
          );
        }
      }
    });
  });

  return { spec: errors.length > 0 ? null : spec, errors, warnings };
}
