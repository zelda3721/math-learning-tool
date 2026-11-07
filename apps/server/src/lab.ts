import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  LlmHttpError,
  LocalOnlyViolationError,
  loadLlmConfig,
  type ChatMessage,
  type ChatOptions,
  type LlmStreamEvent,
} from "@mathtutor/llm-client";
import type { AppState } from "./app.js";
import type { AuthUser } from "./auth.js";
import { createServerLlmClient } from "./llm.js";

/**
 * AI 实验台（轻量版，PLAN 阶段 3）：家长能把一句话发给模型、看见它怎么回、
 * 改了温度或换了个模型之后差在哪。
 *
 * 它存在的理由不是"给个对话框"，而是让**参数与产出的关系看得见**：
 * 讲解质量不稳时，家长（以及维护这套系统的我们）需要一个能复现的最小实验——
 * 同一句话、同一台机器，只动温度或模型，差多少毫秒、差在哪里，当场看。
 *
 * 两条硬约束：
 * 1. 只给家长（见下方 guard 的说明）；
 * 2. 一律走 `createServerLlmClient`（见 `defaultBackend` 的说明）——
 *    实验台不是法外之地，LOCAL_ONLY 与越界审计对它同样生效。
 */

/** 提示词上限：实验台是"一句话的小实验"，不是长文档处理入口 */
export const LAB_PROMPT_MAX = 2000;

/** 单次调用最多等多久。本地模型首次加载可能几十秒，但绝不能无限挂住请求 */
export const LAB_TIMEOUT_MS = 120_000;

/**
 * 实验台输出的 token 上限。
 * 比正式讲解（8192）小得多：这里要的是"看一眼差别"，不是生成长文；
 * 上限小一点，长文模型也不会把一次对比拖成几分钟。
 */
const LAB_MAX_TOKENS = 1200;

/** 模型名上限：够放常见的 `vendor/model:tag`，又不至于被塞进来一整段提示词 */
const LAB_MODEL_MAX = 120;

/** 温度区间与 LlmClient 的语义一致：0 最确定、2 最发散 */
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

// ---------------------------------------------------------------------------
// 可注入的客户端（单测用假 client，绝不真连模型）
// ---------------------------------------------------------------------------

/** 最小 LLM 客户端接口：与 LlmClient.chat 结构兼容，假 client 只需实现它 */
export interface LabClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<LlmStreamEvent>;
}

export interface LabBackend {
  client: LabClient;
  /** 端点默认模型名（请求里没写 model 时用它，并如实回报给前端） */
  model: string;
  /** 当前实例是否处在 LOCAL_ONLY 下——响应里如实写出来，家长才知道数据没出机器 */
  localOnly: boolean;
}

export type LabBackendFactory = () => LabBackend;

/**
 * 生产用的后端：**必须**经 `createServerLlmClient` 造客户端。
 *
 * 为什么不能在这里 `new LlmClient(...)`：那个函数是服务端唯一的 LLM 出口，
 * LOCAL_ONLY 的硬拦截（拿到非本地地址直接抛）和越界审计都装在里面。
 * 实验台能自由输入任意提示词，如果它自己开一个口子，就等于在审计和
 * LOCAL_ONLY 之外多了一条旁路——而"加第十个调用点时必然漏掉一个"正是
 * 当初收敛成单一入口的原因（见 llm.ts 顶部注释）。
 *
 * dataDir 用 `state.config.dataDir`（与 config.ts 解析 DATA_DIR 同口径）：
 * 越界审计要落在同一个 `llm-audit.jsonl` 里，而不是另起一份。
 */
function defaultBackend(dataDir: string): LabBackend {
  const config = loadLlmConfig(process.env);
  return {
    client: createServerLlmClient(config, "main", { dataDir }),
    model: config.main.model,
    localOnly: config.localOnly,
  };
}

// ---------------------------------------------------------------------------
// 参数归一
// ---------------------------------------------------------------------------

/** 温度夹到 0–2：滑杆之外还可能是手搓的请求，越界的值不报错、直接夹住 */
export function clampTemperature(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(TEMPERATURE_MAX, Math.max(TEMPERATURE_MIN, value));
}

/** 模型名规整：去空白；空串按"没指定"处理（走端点默认模型） */
export function normalizeModel(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 把异常翻成一句家长能读懂的话。
 *
 * 不把原始堆栈丢给前端：页面上写着"ECONNREFUSED 127.0.0.1:1234"对家长毫无用处，
 * 但"模型端点没起来"和"只许本地却配了云端"指向完全不同的动作，必须分清。
 */
export function describeLlmError(err: unknown): string {
  if (err instanceof LocalOnlyViolationError) {
    return (
      `这台机器设了只许本地模型（LOCAL_ONLY），可模型地址指向了云端：${err.baseUrl}。` +
      `实验台不会替你把内容发出去——请把 .env 里的 LLM_API_BASE 改回本机/局域网地址；` +
      `确实要用云端，得显式设 LOCAL_ONLY=0（越界请求都会记审计）。`
    );
  }
  if (err instanceof LlmHttpError) {
    return `模型端返回 HTTP ${err.status}（常见原因：模型还没加载完，或端点在重启）。稍等再试。`;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `等了 ${Math.round(LAB_TIMEOUT_MS / 1000)} 秒模型没回话。大概率在加载模型，或端点卡住了。`;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return `连不上模型端点：${detail}。检查 .env 里的 LLM_API_BASE，并确认 LM Studio / oMLX 已经启动。`;
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

export interface LabCallResult {
  reply: string;
  /** 墙钟耗时（含排队、流式收尾），毫秒 */
  ms: number;
  model: string;
  /** 实际下发的温度；null 表示没指定、由端点默认值决定 */
  temperature: number | null;
  localOnly: boolean;
  /** 失败时的可读原因；成功时没有这个字段 */
  error?: string;
}

/** 跑一次：把流式事件里的可见文本拼起来，顺手记下墙钟耗时 */
async function runOnce(
  backend: LabBackend,
  prompt: string,
  opts: { temperature?: number; model?: string },
): Promise<LabCallResult> {
  const startedAt = Date.now();
  const model = opts.model ?? backend.model;
  const base = { model, temperature: opts.temperature ?? null, localOnly: backend.localOnly };
  let text = "";

  try {
    const stream = backend.client.chat([{ role: "user", content: prompt }], {
      // 两个覆盖都交给 llm-client：undefined 表示"用客户端/端点的默认值"，
      // 这里不自己补默认值，免得实验台上跑的东西和真实调用不是一回事
      temperature: opts.temperature,
      model: opts.model,
      maxTokens: LAB_MAX_TOKENS,
      signal: AbortSignal.timeout(LAB_TIMEOUT_MS),
    });
    for await (const ev of stream) {
      if (ev.type === "text") text += ev.text;
      // done 里带的是整段累计文本（含"被截断的思考提升为正文"那一种）。
      // 它比逐字拼更长时才采用，免得把正文覆盖成残缺的一份
      else if (ev.type === "done" && ev.text.length > text.length) text = ev.text;
    }
    return { reply: text, ms: Date.now() - startedAt, ...base };
  } catch (err) {
    // 失败的半截输出也回给前端：实验台上"它说到一半崩了"本身就是信息
    return { reply: text, ms: Date.now() - startedAt, ...base, error: describeLlmError(err) };
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const SideSchema = z
  .object({
    temperature: z.number().finite().optional(),
    model: z.string().optional(),
  })
  .optional();

const CompareSchema = z.object({
  prompt: z.string(),
  a: SideSchema,
  b: SideSchema,
});

const RunSchema = z.object({
  prompt: z.string(),
  temperature: z.number().finite().optional(),
  model: z.string().optional(),
});

/**
 * POST /run → { reply, ms, model, temperature, localOnly }
 * POST /compare → { prompt, a, b, deltaMs }（a/b 各含 reply/ms/model/temperature/error?）
 */
export function labRoutes(state: AppState, backendFactory?: LabBackendFactory): Hono {
  const app = new Hono();

  /**
   * 只给家长。
   *
   * 不是"孩子也能玩一玩"：
   * - 实验台是一个可以任意写提示词、直接拿到模型原文的窗口——不经过安全层、
   *   不经过苏格拉底式约束、不判卷、不挡答案。孩子那边每个入口都得过这些闸
   *   （见 safety.ts / explore.ts），实验台对孩子开门就等于给了一条绕过全部约束的旁路；
   * - 它显示的是"这台机器上跑的是哪个模型、一次多久"，那是运维视角，不是学习面。
   *
   * 与 app.ts 里 `requireParentRole` 同一套判定；这里自己写一遍是因为
   * app.ts 已经 import 了本文件，反向 import 会成环。改判定条件时两处一起改。
   */
  const parentOnly = async (c: Context, next: () => Promise<void>) => {
    const open = state.authDisabled || !state.auth;
    const isParent = open || (c.get("user") as AuthUser | undefined)?.role === "parent";
    if (!isParent) return c.json({ error: "仅家长可用" }, 403);
    return next();
  };
  app.use("/run", parentOnly);
  app.use("/compare", parentOnly);

  const backend = (): LabBackend =>
    (backendFactory ?? (() => defaultBackend(state.config.dataDir)))();

  /** 提示词校验：长度与空白单独判，好回一句说得清为什么被拒的话 */
  const checkPrompt = (prompt: string): string | null => {
    if (!prompt.trim()) return "提示词不能为空";
    if (prompt.length > LAB_PROMPT_MAX) {
      return `提示词最多 ${LAB_PROMPT_MAX} 字，这一条有 ${prompt.length} 字。`;
    }
    return null;
  };
  const checkModel = (model: string | undefined): string | null =>
    model && model.trim().length > LAB_MODEL_MAX ? `模型名最多 ${LAB_MODEL_MAX} 个字符` : null;

  app.post("/run", async (c) => {
    const parsed = RunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 { prompt: string }" }, 400);
    const promptError = checkPrompt(parsed.data.prompt);
    if (promptError) return c.json({ error: promptError }, 400);
    const modelError = checkModel(parsed.data.model);
    if (modelError) return c.json({ error: modelError }, 400);

    let b: LabBackend;
    try {
      b = backend();
    } catch (err) {
      // 模型没配好（含 LOCAL_ONLY 拦下云端地址）是**配置问题**，不是 500：
      // 回一句能照着做的话，前端就能把它当提示语显示出来
      return c.json({ error: describeLlmError(err) }, 502);
    }

    const result = await runOnce(b, parsed.data.prompt, {
      temperature: clampTemperature(parsed.data.temperature),
      model: normalizeModel(parsed.data.model),
    });
    if (result.error) {
      return c.json({ error: result.error, ms: result.ms, model: result.model }, 502);
    }
    return c.json(result);
  });

  app.post("/compare", async (c) => {
    const parsed = CompareSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 { prompt, a, b }" }, 400);
    const promptError = checkPrompt(parsed.data.prompt);
    if (promptError) return c.json({ error: promptError }, 400);
    for (const side of [parsed.data.a, parsed.data.b]) {
      const modelError = checkModel(side?.model);
      if (modelError) return c.json({ error: modelError }, 400);
    }

    let b: LabBackend;
    try {
      b = backend();
    } catch (err) {
      return c.json({ error: describeLlmError(err) }, 502);
    }

    // 两边并行：串行跑一次对比要等两倍时间，而且两次调用的等待时长会互相污染
    // （后一个"看起来更慢"，只是因为它排在后面）
    const [a, second] = await Promise.all([
      runOnce(b, parsed.data.prompt, {
        temperature: clampTemperature(parsed.data.a?.temperature),
        model: normalizeModel(parsed.data.a?.model),
      }),
      runOnce(b, parsed.data.prompt, {
        temperature: clampTemperature(parsed.data.b?.temperature),
        model: normalizeModel(parsed.data.b?.model),
      }),
    ]);

    // 两边都废了才算这次实验失败；只坏一边时把另一边照实交出去——
    // 那一次调用是真的花了时间，丢掉它等于让人白等
    if (a.error && second.error) {
      return c.json({ error: `两边都失败了。A：${a.error} B：${second.error}`, a, b: second }, 502);
    }

    return c.json({
      prompt: parsed.data.prompt,
      a,
      b: second,
      /** b 相对 a 的耗时差（正数表示 B 更慢），前端据此说"快/慢多少" */
      deltaMs: second.ms - a.ms,
    });
  });

  return app;
}
