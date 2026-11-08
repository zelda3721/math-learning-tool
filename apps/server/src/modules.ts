import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE } from "./auth.js";
import { effectiveLearnerId, type AppState } from "./app.js";
import type { Repo } from "./repo.js";

/**
 * 模块开关：家长可以关掉某一块功能，服务端在**入口**就挡掉。
 *
 * 为什么挡在服务端而不是只在界面上藏起来：
 * 藏起来只是"没给入口"，孩子（或任何拿到这台机器的人）换一个客户端就能用。
 * 关模块是家长的决定，它得像安全层一样在服务器生效，界面只是把决定说出来。
 *
 * 默认全开：家长没表态就不该少东西。存的是**覆盖值**（关掉的才写进来），
 * 这样以后加模块不必给每个孩子补一条记录。
 */

export interface ModuleSpec {
  id: string;
  label: string;
  /** 给孩子看的关掉后的话术：说清"被关了"和"怎么办"，不甩一词 status code */
  blockedReply: string;
  hint: string;
}

export const MODULES: ModuleSpec[] = [
  {
    id: "explore",
    label: "探索对话",
    blockedReply: "家长把「探索对话」关掉了。想接着聊的话，先跟家长说一声。",
    hint: "孩子可以和导师自由讨论一个知识点（不喂答案，只引导）。",
  },
  {
    id: "english",
    label: "英语学习",
    blockedReply: "家长把「英语」关掉了。想练单词和读短文的话，先跟家长说一声。",
    hint: "词汇卡（SM-2 复习）与分级阅读，全部本地内容、不经过模型。",
  },
  {
    id: "classroom",
    label: "AI 课堂",
    blockedReply: "家长把「课堂」关掉了。想上课的话，先跟家长说一声。",
    hint: "一步一步讲一节小课，讲到一半会停下来问一道题。",
  },
  {
    /*
     * 「问一道题」是最依赖模型、也最容易被当成作业解题机的入口：
     * 孩子把作业题交上来，引擎会给出完整解法。它必须能被家长关掉，
     * 也必须和练习共用同一个时长闸——早先两样都没有。
     */
    id: "ask",
    label: "问一道题",
    blockedReply: "家长把「问一道题」关掉了。有不会的题，先做今天的练习，或者跟家长说一声。",
    hint: "孩子把题库外的题交上来，系统先让他自己做一次，答错才一级级给提示。",
  },
];

export type ModuleState = Record<string, boolean>;

/** 读一个孩子的模块开关：缺键 = 开 */
export function readModules(repo: Repo, learnerId: string): ModuleState {
  const stored = repo.learnerPrefs(learnerId).modules ?? {};
  const result: ModuleState = {};
  for (const spec of MODULES) result[spec.id] = stored[spec.id] !== false;
  // 未知键原样保留：旧版本写过的东西不该被这次读改写掉
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in result)) result[key] = value !== false;
  }
  return result;
}

/** 只写传进来的键，其余保持原样（关掉课堂不该顺手把探索打开） */
export function writeModules(repo: Repo, learnerId: string, patch: ModuleState): ModuleState {
  const current = repo.learnerPrefs(learnerId).modules ?? {};
  repo.setLearnerPrefs(learnerId, { modules: { ...current, ...patch } });
  return readModules(repo, learnerId);
}

export function moduleEnabled(repo: Repo, learnerId: string | undefined, moduleId: string): boolean {
  if (!learnerId) return true;
  return readModules(repo, learnerId)[moduleId] !== false;
}

export function moduleBlockedReply(moduleId: string): string {
  return MODULES.find((m) => m.id === moduleId)?.blockedReply ?? "家长把这个模块关掉了。";
}

/** 统一的 403 响应体：`error` 是给孩子看的一句话，`code` 给界面判断 */
export function moduleBlockedBody(moduleId: string): { error: string; code: string; module: string } {
  return { error: moduleBlockedReply(moduleId), code: "module-disabled", module: moduleId };
}

/**
 * 课堂前缀的模块闸。
 *
 * 为什么这一段装在组合根（index.ts）包一层，而不是写进创建路由的地方：
 * 课堂路由与 createApp 目前都由别的改动在动，本改动不去碰它们。
 * 这一层包在 app 外面，进路由**之前**就挡住，语义上等于一条全局中间件。
 *
 * 学习者是谁：孩子会话由服务端签发的 learnerId 决定（请求里传什么都覆盖掉，
 * 与 `effectiveLearnerId` 同一套规则）；家长/调试则按显式 `?learnerId=`。
 * 认不出是谁时不拦——家长自己要能进去看孩子关掉了什么。
 */
export function moduleGateMiddleware(state: AppState, moduleId: string): MiddlewareHandler {
  return async (c, next) => {
    // 认证中间件在内层 app 里，这里先自己解出 user，否则孩子会话永远认不出人
    if (state.auth && !state.authDisabled) {
      const token = getCookie(c, SESSION_COOKIE);
      const user = token ? state.auth.userForSession(token) : null;
      if (user) c.set("user", user);
    }
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (learnerId && state.repo.getLearner(learnerId) && !moduleEnabled(state.repo, learnerId, moduleId)) {
      return c.json(moduleBlockedBody(moduleId), 403);
    }
    return next();
  };
}

/**
 * 把整个 app 包一层：`/api/v1/classroom/*` 在模块被关掉时返回 403。
 *
 * 组合根与测试各自套这一层（同一个函数），所以测试验的就是线上那条路径。
 */
export function withModuleGate(app: Hono, state: AppState): Hono {
  const gated = new Hono();
  const classroom = moduleGateMiddleware(state, "classroom");
  gated.use("/api/v1/classroom", classroom);
  gated.use("/api/v1/classroom/*", classroom);
  gated.route("/", app);
  return gated;
}

/** 探索在它自己的路由里判（那里已经解析好 learnerId），这里不重复包一层闸 */
