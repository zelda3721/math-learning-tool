import type { Knowledge } from "@mathtutor/knowledge";
import type { Question } from "@mathtutor/schema";

/**
 * 引擎讲解生成（模式 B · Manim 视频，P2）：
 * server 直连引擎 POST /api/v1/chat（SSE），收集到 done 事件为止。
 * 诊断结果直接指导导演：题型 essence + 误概念注入 extra_directives（设计 §07）。
 */

export interface EngineRunResult {
  status: "ok" | "exhausted" | "failed";
  sessionId?: string;
  videoUrl?: string;
  doneText?: string;
}

export interface EngineChatPayload {
  problem: string;
  grade: string;
  learner_id?: string;
  extra_directives?: string;
  /** 原题原图（data URL）。视频链路同样要接原图：导演照它的转写重画，不许凭空想象 */
  figure_image?: string;
}

/** 组合导演指令：essence（题型本质）+ 误概念（针对性视觉论证） */
export function composeDirectives(args: {
  knowledge: Knowledge;
  question?: Question;
  focusNodeId?: string;
  misconceptionId?: string;
}): string | undefined {
  const parts: string[] = [];
  const pt = args.question?.problemTypeId
    ? args.knowledge.problemTypes.find((p) => p.id === args.question!.problemTypeId)
    : undefined;
  if (pt) parts.push(`题型本质：${pt.essence}`);
  const node = args.focusNodeId ? args.knowledge.index.getNode(args.focusNodeId) : undefined;
  if (node && args.misconceptionId) {
    const m = node.misconceptions.find((x) => x.id === args.misconceptionId);
    if (m) parts.push(`学生的误概念：${m.desc}。请针对该误概念设计视觉论证，让图形直接反驳这个误解。`);
  } else if (node) {
    parts.push(`讲解重心放在「${node.name}」这个知识点上。`);
  }
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * 消费引擎 SSE 流直到 done/error。零依赖的 event:/data: 行解析。
 * @param fetchImpl 可注入（测试 mock 引擎响应）
 */
export async function generateViaEngine(
  engineUrl: string,
  payload: EngineChatPayload,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 600_000,
): Promise<EngineRunResult> {
  const resp = await fetchImpl(`${engineUrl}/api/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok || !resp.body) throw new Error(`引擎响应 ${resp.status}`);

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let sessionId: string | undefined;

  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (!data) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (currentEvent === "session") {
            sessionId = String(parsed.session_id ?? "");
          } else if (currentEvent === "done") {
            return {
              status: (parsed.status as EngineRunResult["status"]) ?? "failed",
              sessionId,
              videoUrl: parsed.final_video_url ? String(parsed.final_video_url) : undefined,
              doneText: parsed.text ? String(parsed.text) : undefined,
            };
          } else if (currentEvent === "error" && parsed.fatal) {
            return { status: "failed", sessionId, doneText: String(parsed.message ?? "engine error") };
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { status: "failed", sessionId, doneText: "引擎流意外结束（无 done 事件）" };
}
