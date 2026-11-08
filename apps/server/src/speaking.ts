import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { effectiveLearnerId, type AppState } from "./app.js";
import { budgetBlockedPayload } from "./chatBudget.js";
import { moduleBlockedBody, moduleEnabled } from "./modules.js";
import { screenLearnerInput, screenModelOutput } from "./safety.js";
import type { HintProvider } from "./hint.js";

/**
 * 英语口语对练（PLAN 阶段 5）。
 *
 * 形态：孩子和 AI 扮演的情景里的角色对话。语音链路全在本地：
 * 麦克风 → compute-worker `/v1/asr` → 导师技能（recast 纠错）→ `/v1/tts` → 播放。
 *
 * 三条纪律，都是"不喂答案"在语言学习里的落法：
 * ① **recast 而不是纠错报告**：孩子说错了，AI 的下一次回复里自然重复正确说法，
 *    不点名、不解释语法——打断交流的纠错会让孩子不敢开口。
 * ② **中文求助只给半句**：卡住可以用中文问，但只给"你可以说：I would like…"，
 *    不把整句端上来。
 * ③ **不打分、不计入掌握度**：口语是 `ai_unverified`，只写练习记录
 *    （时长、轮次、用到的表达），家长可以回看转写（默认关，和探索对话同一个开关）。
 */
export interface SpeakingScenario {
  id: string;
  title: string;
  level: string;
  aiRole: string;
  opening: string;
  goals: string[];
  expressions: string[];
  topics: string[];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function speakingContentPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGLISH_SPEAKING_PATH
    ? path.resolve(repoRoot, env.ENGLISH_SPEAKING_PATH)
    : path.join(repoRoot, "subjects", "english", "content", "speaking.json");
}

let cached: SpeakingScenario[] | null = null;

/** 读情景表；文件坏了返回空表并打日志，不让口语一个模块拖垮整个服务 */
export function loadScenarios(file = speakingContentPath()): SpeakingScenario[] {
  if (cached) return cached;
  if (!existsSync(file)) {
    console.warn(`[speaking] 情景文件不存在：${file}`);
    return [];
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as SpeakingScenario[];
    cached = raw;
    return raw;
  } catch (err) {
    console.warn(`[speaking] 情景文件读不出来：${String(err)}`);
    return [];
  }
}

export function scenarioById(id: string): SpeakingScenario | undefined {
  return loadScenarios().find((s) => s.id === id);
}

/** 导师提示词：情景 + 三条纪律。模型看不到任何"标准答案"，因为这里没有答案。 */
export function speakingPrompt(scenario: SpeakingScenario, history: { role: "child" | "tutor"; text: string }[]): string {
  const lines = history.slice(-8).map((h) => `${h.role === "child" ? "孩子" : "你"}：${h.text}`);
  return `你在和一个中国孩子做英语口语练习。你扮演：${scenario.aiRole}。
情景：${scenario.title}（CEFR ${scenario.level}）。
孩子这轮想练到的表达：${scenario.expressions.join(" / ")}。话题范围：${scenario.topics.join("、")}。

规则（必须遵守）：
1. 只用简短、口语化的英语，一次最多两句话，结尾提一个简单问题让孩子继续说。
2. 孩子说错了时用 recast：在你的回复里自然地重复一遍正确说法，**不要点名批评，不要解释语法**。
3. 孩子用中文求助时：先用中文给半句提示（例如"你可以说：I would like…"），不要把整句答案给全；然后用英语问一句。
4. 不打分、不评价发音、不输出列表或标题、不切换话题到情景之外。
5. 只输出你要说给孩子的那句话本身。

对话记录：
${lines.join("\n") || "（还没有开始）"}`;
}

/** 结束时的表达小结：确定性统计，不调模型（"你今天用到的表达/可以试试的说法"） */
export function summarizeSession(
  scenario: SpeakingScenario,
  turns: { role: string; text: string }[],
): { turns: number; used: string[]; tryNext: string[]; childWords: number } {
  const childText = turns.filter((t) => t.role === "child").map((t) => t.text).join(" ").toLowerCase();
  const used = scenario.expressions.filter((e) => {
    // 取表达里最实的那几个词做包含判断（"I'd like ..., please." → "like"）
    const key = e.replace(/[.…]/g, "").split(/[\s,]+/).filter((w) => w.length >= 4).slice(0, 2);
    return key.length > 0 && key.every((w) => childText.includes(w.toLowerCase()));
  });
  const tryNext = scenario.expressions.filter((e) => !used.includes(e));
  const childWords = childText.split(/\s+/).filter(Boolean).length;
  return { turns: turns.filter((t) => t.role === "child").length, used, tryNext, childWords };
}

const SessionSchema = z.object({
  learnerId: z.string().optional(),
  scenarioId: z.string().optional(),
});

const TurnSchema = z.object({
  learnerId: z.string().optional(),
  sessionId: z.string(),
  /** 录音（data URL 或裸 base64）。测试/降级时可以只传 text */
  audio: z.string().optional(),
  text: z.string().max(1000).optional(),
});

async function engineJson(state: AppState, pathname: string, body: unknown, timeoutMs: number): Promise<Response> {
  const fetchImpl = state.engineFetch ?? fetch;
  return fetchImpl(`${state.config.engineUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function speakingRoutes(state: AppState): Hono {
  const app = new Hono();

  /** 口语入口的两道闸：模块（英语）+ 每日时长 */
  const gate = (c: Context, learnerId: string): Response | undefined => {
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    const blocked = budgetBlockedPayload(state.repo, learnerId);
    if (blocked) return c.json(blocked, 429);
    return undefined;
  };

  /** 可选情景 + 语音后端状态：界面据此决定能不能开口说 */
  app.get("/scenarios", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 400);
    if (!moduleEnabled(state.repo, learnerId, "english")) return c.json(moduleBlockedBody("english"), 403);
    return c.json({
      scenarios: loadScenarios().map(({ id, title, level, goals, expressions }) => ({ id, title, level, goals, expressions })),
    });
  });

  app.post("/session", async (c) => {
    const parsed = SessionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 404);
    const blocked = gate(c, learnerId);
    if (blocked) return blocked;

    const all = loadScenarios();
    if (all.length === 0) return c.json({ error: "还没有口语情景内容" }, 503);
    // 不指定就挑一个——孩子第一次打开不该面对一个空下拉框
    const scenario = (parsed.data.scenarioId && all.find((s) => s.id === parsed.data.scenarioId)) || all[0]!;
    const sessionId = state.repo.createSpeakingSession(learnerId, scenario.id);
    state.repo.insertSpeakingTurn({ sessionId, learnerId, role: "tutor", text: scenario.opening });
    const audio = await synthesize(state, scenario.opening);
    return c.json({
      sessionId,
      scenario: { id: scenario.id, title: scenario.title, level: scenario.level, goals: scenario.goals, expressions: scenario.expressions },
      opening: scenario.opening,
      audio: audio?.base64 ?? null,
      ttsAvailable: Boolean(audio),
    });
  });

  app.post("/turn", async (c) => {
    const parsed = TurnSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId || !state.repo.getLearner(learnerId)) return c.json({ error: "需要 learnerId" }, 404);
    const blocked = gate(c, learnerId);
    if (blocked) return blocked;

    const session = state.repo.getSpeakingSession(parsed.data.sessionId);
    if (!session || session.learnerId !== learnerId) return c.json({ error: "会话不存在" }, 404);
    const scenario = scenarioById(session.scenarioId);
    if (!scenario) return c.json({ error: "情景不存在" }, 404);

    const startedAt = Date.now();
    // 1) 录音 → 文字（本地 ASR）
    let heard = parsed.data.text?.trim() ?? "";
    let asrMs = 0;
    if (!heard && parsed.data.audio) {
      const asrStart = Date.now();
      const result = await transcribe(state, parsed.data.audio);
      asrMs = Date.now() - asrStart;
      if (!result.ok) {
        return c.json(
          { error: result.error, code: "asr-failed", heard: "", reply: null },
          result.unavailable ? 503 : 502,
        );
      }
      heard = result.text;
    }
    if (!heard) return c.json({ error: "这一轮没有听到声音，再说一次试试", code: "empty-speech" }, 422);

    // 2) 安检：孩子说的话不进模型（和探索对话同一条规矩）
    const screen = screenLearnerInput(state.repo, learnerId, heard);
    if (screen.blocked) {
      state.repo.insertSpeakingTurn({
        sessionId: session.id,
        learnerId,
        role: "blocked",
        safetyReason: "input",
      });
      return c.json({ heard, blocked: true, reply: screen.reply, audio: null });
    }
    state.repo.insertSpeakingTurn({ sessionId: session.id, learnerId, role: "child", text: heard });

    // 3) 导师回复（模型）；没有模型就诚实说"现在说不出话"，而不是假装在聊
    const llm: HintProvider | null = state.hintProvider;
    if (!llm) {
      return c.json({ heard, error: "现在没有可用的模型，口语对练暂时开不了", code: "no-model" }, 503);
    }
    const history = state.repo
      .listSpeakingTurns(session.id)
      .filter((t) => t.role === "child" || t.role === "tutor")
      .map((t) => ({ role: t.role as "child" | "tutor", text: t.text }));
    let reply = "";
    const llmStart = Date.now();
    try {
      reply = (await llm.generate(speakingPrompt(scenario, history))).trim();
    } catch (err) {
      return c.json({ heard, error: `模型没有答上来：${String(err)}`, code: "llm-failed" }, 502);
    }
    const llmMs = Date.now() - llmStart;

    // 4) 输出侧安检：模型要说给孩子的话
    const out = screenModelOutput(state.repo, learnerId, reply);
    if (out.blocked) {
      state.repo.insertSpeakingTurn({ sessionId: session.id, learnerId, role: "blocked", safetyReason: "output" });
      return c.json({ heard, blocked: true, reply: out.reply, audio: null });
    }
    reply = reply.slice(0, 400);
    state.repo.insertSpeakingTurn({ sessionId: session.id, learnerId, role: "tutor", text: reply });

    // 5) 合成（失败就当没有声音：文字照给，不让孩子面对一个错误码）
    const audio = await synthesize(state, reply);
    const totalMs = Date.now() - startedAt;
    state.repo.appendEvent(learnerId, "speaking_turn", {
      sessionId: session.id,
      scenarioId: scenario.id,
      asrMs,
      llmMs,
      ttsMs: audio?.ms ?? 0,
      totalMs,
      verification: "ai_unverified",
    });
    return c.json({
      heard,
      reply,
      audio: audio?.base64 ?? null,
      latency: { asrMs, llmMs, ttsMs: audio?.ms ?? 0, totalMs },
    });
  });

  app.post("/end", async (c) => {
    const parsed = z.object({ sessionId: z.string(), learnerId: z.string().optional() }).safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: "参数错误" }, 400);
    const learnerId = effectiveLearnerId(c, state, parsed.data.learnerId);
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 404);
    const session = state.repo.getSpeakingSession(parsed.data.sessionId);
    if (!session || session.learnerId !== learnerId) return c.json({ error: "会话不存在" }, 404);
    const scenario = scenarioById(session.scenarioId);
    const turns = state.repo.listSpeakingTurns(session.id);
    state.repo.endSpeakingSession(session.id);
    const summary = scenario
      ? summarizeSession(scenario, turns.map((t) => ({ role: t.role, text: t.text })))
      : { turns: 0, used: [], tryNext: [], childWords: 0 };
    state.repo.appendEvent(learnerId, "speaking_session", {
      sessionId: session.id,
      scenarioId: session.scenarioId,
      ...summary,
      // 不打分：只留"说了多少、用到哪些表达"
      verification: "ai_unverified",
    });
    return c.json({ summary });
  });

  return app;
}

/** 语音识别：引擎不可用就诚实返回"没听清"，不让孩子以为是自己说错了 */
async function transcribe(
  state: AppState,
  audio: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string; unavailable: boolean }> {
  const base64 = audio.replace(/^data:[\w/+.-]+;base64,/, "");
  try {
    const res = await engineJson(state, "/api/v1/asr", { audio_base64: base64, language: "en" }, 30_000);
    if (res.status === 501) {
      return { ok: false, error: "这台机器上还没装本地语音识别，暂时不能开口说", unavailable: true };
    }
    if (!res.ok) {
      return { ok: false, error: "这一句没听清，再说一次试试", unavailable: false };
    }
    const data = (await res.json()) as { text?: string };
    return { ok: true, text: (data.text ?? "").trim() };
  } catch {
    return { ok: false, error: "语音识别服务没有响应，先说文字也行", unavailable: true };
  }
}

async function synthesize(state: AppState, text: string): Promise<{ base64: string; ms: number } | null> {
  const started = Date.now();
  try {
    const res = await engineJson(state, "/api/v1/tts", { text }, 30_000);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return { base64: buf.toString("base64"), ms: Date.now() - started };
  } catch {
    return null;
  }
}
