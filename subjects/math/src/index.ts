import type { SubjectPackage, VerifierDef } from "@mathtutor/core";
import { ITEM_TYPES, JUDGES } from "./judges.js";

/**
 * 数学学科包。
 *
 * 行为与平移前完全一致：判卷逻辑原样搬进来，适配层不做任何判定，
 * 现有 30 条判卷测试全部沿用（见 tests/grading.test.ts）。
 */

/** 验证器：数学的可执行验算在 Python worker 的 `/v1/math/execute`（SymPy） */
const VERIFIERS: VerifierDef[] = [{ id: "math.sympy", subject: "math", kind: "executable" }];

export const mathSubject: SubjectPackage = {
  id: "math",
  name: "数学",
  itemTypes: ITEM_TYPES,
  judges: JUDGES,
  verifiers: VERIFIERS,
  /**
   * 数学的视觉词汇**不在这里重复声明**：SceneSpec 的 17 种图元就是数学的图元表，
   * 而它已经在 `packages/schema/src/scenespec.ts` 里定义并渲染。
   * 再抄一份到这里，只会在某次加图元时变成第二份过期的真相。
   * 新学科的图元才需要在这里声明（以 `<subject>.` 前缀命名）。
   */
  visuals: [],
};

export * from "./grading.js";
export * from "./judges.js";
