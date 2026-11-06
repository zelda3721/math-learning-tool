/**
 * 播放动作的形状——**刻意只保留上游用到的字段**。
 *
 * Adapted from OpenMAIC `packages/@openmaic/dsl/src/action.ts` @795420c1 (MIT)
 *
 * 为什么不把上游的 Action 契约整包搬来：那是 9,329 行的 DSL，围着"多 agent 圆桌演讲"
 * 的语义长的，而本项目的场景描述是 SceneSpec。两套契约并存，改一处要改两处，
 * 新人也不知道该用哪套（PLAN 第二部分的唯一原则）。
 *
 * 被搬来的那几个模块（导航边界、断点续学、派生状态）**只用到 `id` 与 `type`**——
 * 于是这里就只声明这两个。将来接课堂时，把本项目的动作类型对齐成这个形状即可，
 * 搬进来的算法一行都不用改。
 */
export interface PlaybackAction {
  id: string;
  type: string;
}
