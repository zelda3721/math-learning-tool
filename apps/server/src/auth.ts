import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EducationLevel } from "@mathtutor/schema";

/**
 * 账户体系（家庭部署）：
 * - 家长 = 管理员，唯一账号，首次运行经 setup 创建
 * - 孩子自注册（上限 CHILD_LIMIT），账号一对一绑定 learner
 * - 会话：随机 token（DB 存储，可吊销），HttpOnly cookie
 * - 密码：scrypt + 独立盐；比较用 timingSafeEqual
 */

// Hono 上下文变量声明合并：c.get("user") / c.set("user", ...) 全局有类型
declare module "hono" {
  interface ContextVariableMap {
    user?: AuthUser;
  }
}

export const CHILD_LIMIT = 5;
export const SESSION_COOKIE = "mt_session";
const SESSION_TTL_DAYS = 30;

export interface AuthUser {
  id: string;
  role: "parent" | "child";
  username: string;
  learnerId?: string;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export class AuthStore {
  constructor(private readonly db: DatabaseSync) {}

  parentExists(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM auth_users WHERE role = 'parent' LIMIT 1").get());
  }

  childCount(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM auth_users WHERE role = 'child'").get();
    return Number(r?.n ?? 0);
  }

  usernameTaken(username: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM auth_users WHERE username = ?").get(username));
  }

  createUser(args: {
    role: "parent" | "child";
    username: string;
    password: string;
    learnerId?: string;
  }): AuthUser {
    const id = randomUUID();
    const salt = randomBytes(16).toString("hex");
    this.db
      .prepare(
        "INSERT INTO auth_users (id, role, username, password_hash, salt, learner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        args.role,
        args.username,
        hashPassword(args.password, salt),
        salt,
        args.learnerId ?? null,
        new Date().toISOString(),
      );
    return { id, role: args.role, username: args.username, learnerId: args.learnerId };
  }

  verifyLogin(username: string, password: string): AuthUser | null {
    const r = this.db.prepare("SELECT * FROM auth_users WHERE username = ?").get(username);
    if (!r) return null;
    const expected = Buffer.from(String(r.password_hash), "hex");
    const actual = Buffer.from(hashPassword(password, String(r.salt)), "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return this.rowToUser(r as Record<string, unknown>);
  }

  resetPassword(userId: string, password: string): boolean {
    const salt = randomBytes(16).toString("hex");
    const res = this.db
      .prepare("UPDATE auth_users SET password_hash = ?, salt = ? WHERE id = ?")
      .run(hashPassword(password, salt), salt, userId);
    // 改密后吊销全部会话
    this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
    return Number(res.changes) > 0;
  }

  listChildren(): (AuthUser & { createdAt: string })[] {
    return this.db
      .prepare("SELECT * FROM auth_users WHERE role = 'child' ORDER BY created_at")
      .all()
      .map((r) => ({
        ...this.rowToUser(r as Record<string, unknown>),
        createdAt: String((r as Record<string, unknown>).created_at),
      }));
  }

  getUser(id: string): AuthUser | undefined {
    const r = this.db.prepare("SELECT * FROM auth_users WHERE id = ?").get(id);
    return r ? this.rowToUser(r as Record<string, unknown>) : undefined;
  }

  deleteUser(id: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(id);
    this.db.prepare("DELETE FROM auth_users WHERE id = ?").run(id);
  }

  // ---- sessions ----
  createSession(userId: string): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
    this.db
      .prepare("INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, userId, new Date().toISOString(), expiresAt);
    return { token, expiresAt };
  }

  userForSession(token: string): AuthUser | null {
    const r = this.db
      .prepare(
        `SELECT u.* FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, new Date().toISOString());
    return r ? this.rowToUser(r as Record<string, unknown>) : null;
  }

  destroySession(token: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
  }

  private rowToUser(r: Record<string, unknown>): AuthUser {
    return {
      id: String(r.id),
      role: String(r.role) as AuthUser["role"],
      username: String(r.username),
      learnerId: r.learner_id === null || r.learner_id === undefined ? undefined : String(r.learner_id),
    };
  }
}

export type { EducationLevel };
