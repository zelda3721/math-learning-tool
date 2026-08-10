export { validateSpec, type ValidateResult } from "./validate.js";
export {
  foldBeats,
  MAX_UNITS_PER_GROUP,
  type BeatState,
  type GroupState,
  type Unit,
  type RenderObject,
} from "./fold.js";
export { ExplainerPlayer, type PlayerOptions, type PlayerOptions as ExplainerPlayerOptions } from "./player.js";
export { solveScene, type Scene, type SceneIssue, type Shape } from "./render/scene.js";
export { KNOWN_PRIMITIVES, KNOWN_OPS } from "./refs.js";
/** 数学核心：调用方可独立复算校验引擎给的数值（曲线、斜率、面积） */
export { compileExpression, type EvalFn, type CompileResult } from "./math/expr.js";
export { sampleFunction, type Curve } from "./math/sample.js";
export { buildCoordSystem, unionExtents, type CoordSystem, type Extents } from "./math/coords.js";
