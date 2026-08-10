import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { EducationLevelSchema } from "@mathtutor/schema";
import type { AppState } from "../app.js";
import { CHILD_LIMIT, SESSION_COOKIE, type AuthUser } from "../auth.js";

const CredentialsSchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(4).max(64),
});

const RegisterChildSchema = CredentialsSchema.extend({
  level: EducationLevelSchema,
});

function issueSession(state: AppState, c: Parameters<Hono["fetch"]>[0] extends never ? never : any, user: AuthUser) {
  const { token } = state.auth!.createSession(user.id);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 86400,
  });
  return { user };
}

/** 账户路由（唯一免认证的 API 面） */
export function authRoutes(state: AppState): Hono {
  const app = new Hono();
  const auth = () => state.auth!;

  // 前端引导用：是否已初始化、孩子名额、当前登录者
  app.get("/state", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? auth().userForSession(token) : null;
    return c.json({
      parentExists: auth().parentExists(),
      childCount: auth().childCount(),
      childLimit: CHILD_LIMIT,
      user,
    });
  });

  // 首次运行：创建家长（管理员）账号——仅当尚无家长时
  app.post("/setup-parent", async (c) => {
    if (auth().parentExists()) return c.json({ error: "家长账号已存在" }, 409);
    const parsed = CredentialsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 username 与至少 4 位密码" }, 400);
    if (auth().usernameTaken(parsed.data.username)) return c.json({ error: "用户名已被占用" }, 409);
    const user = auth().createUser({ role: "parent", ...parsed.data });
    return c.json(issueSession(state, c, user), 201);
  });

  // 孩子自注册（上限 CHILD_LIMIT）：账号 + learner 一并创建
  app.post("/register-child", async (c) => {
    if (!auth().parentExists()) return c.json({ error: "请先完成家长账号初始化" }, 409);
    if (auth().childCount() >= CHILD_LIMIT) {
      return c.json({ error: `注册名额已满（最多 ${CHILD_LIMIT} 名）` }, 409);
    }
    const parsed = RegisterChildSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 username、至少 4 位密码 和 level" }, 400);
    if (auth().usernameTaken(parsed.data.username)) return c.json({ error: "这个名字已被使用" }, 409);
    const learner = state.repo.createLearner(parsed.data.username, parsed.data.level);
    const user = auth().createUser({
      role: "child",
      username: parsed.data.username,
      password: parsed.data.password,
      learnerId: learner.id,
    });
    return c.json(issueSession(state, c, user), 201);
  });

  app.post("/login", async (c) => {
    const parsed = CredentialsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要用户名与密码" }, 400);
    const user = auth().verifyLogin(parsed.data.username, parsed.data.password);
    if (!user) return c.json({ error: "用户名或密码不对" }, 401);
    return c.json(issueSession(state, c, user));
  });

  app.post("/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) auth().destroySession(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ---- 家长管理孩子账号 ----
  app.get("/children", (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (user?.role !== "parent") return c.json({ error: "仅家长可用" }, 403);
    return c.json({
      children: auth()
        .listChildren()
        .map((child) => ({
          ...child,
          learner: child.learnerId ? state.repo.getLearner(child.learnerId) : undefined,
        })),
      childLimit: CHILD_LIMIT,
    });
  });

  app.post("/children/:id/reset-password", async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (user?.role !== "parent") return c.json({ error: "仅家长可用" }, 403);
    const parsed = z
      .object({ password: z.string().min(4).max(64) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要至少 4 位新密码" }, 400);
    const target = auth().getUser(c.req.param("id"));
    if (!target || target.role !== "child") return c.json({ error: "孩子账号不存在" }, 404);
    auth().resetPassword(target.id, parsed.data.password);
    return c.json({ ok: true });
  });

  app.delete("/children/:id", (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (user?.role !== "parent") return c.json({ error: "仅家长可用" }, 403);
    const target = auth().getUser(c.req.param("id"));
    if (!target || target.role !== "child") return c.json({ error: "孩子账号不存在" }, 404);
    // 只删账号与会话；learner 学习数据保留（可追溯，名额随之释放）
    auth().deleteUser(target.id);
    return c.json({ ok: true, learnerKept: target.learnerId ?? null });
  });

  return app;
}
