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
export function validateSpec(raw: unknown): ValidateResult {
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
  for (const obj of spec.visual_objects) {
    if (ids.has(obj.id)) errors.push(`duplicate object id: "${obj.id}"`);
    ids.add(obj.id);
    if (!KNOWN_PRIMITIVES.has(obj.primitive)) {
      warnings.push(`unknown primitive "${obj.primitive}" on object "${obj.id}"`);
    }
  }

  spec.scenes.forEach((beat, beatIndex) => {
    beat.actions.forEach((action, actionIndex) => {
      if (!KNOWN_OPS.has(action.op)) {
        warnings.push(`unknown op "${action.op}" at scenes[${beatIndex}].actions[${actionIndex}]`);
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
