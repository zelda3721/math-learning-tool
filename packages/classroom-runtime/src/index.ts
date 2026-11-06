/**
 * 课堂运行时（阶段 3 起）。
 *
 * 当前内容全是**纯逻辑**，零 DOM、零 store 依赖：
 * - 派生状态：从散落的原始变量算出"此刻在干什么"
 * - 断点续学：从哪里接着播、哪些动作可以跳
 * - 导航边界：哪些动作类型不允许中途跳进去
 *
 * 上游的播放引擎（`lib/playback/engine.ts`，939 行）**还没有搬**：
 * 它依赖音频、zustand store 与 choreography，接触面要先改写成我们自己的形状。
 * 见 docs/OPENMAIC_PORT.md 的「依赖锥」一节。
 */
export * from "./machine.js";
export * from "./session.js";
export * from "./persistence.js";
export * from "./redact.js";
export * from "./action.js";
export * from "./types.js";
export * from "./derived-state.js";
export * from "./auto-resume.js";
export * from "./action-navigation.js";
export * from "./action-resume.js";
