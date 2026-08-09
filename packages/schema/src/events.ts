import { z } from "zod";

/**
 * SSE 事件：镜像引擎 infrastructure/agent/events.py 的 7 种现有事件，
 * 新增 diagnosis / review_due 两种（server 侧发射）。
 * v2 信封 {v, seq, event} 适用于 server→web 的一切流（引擎代理流由 server 重新包封）。
 */

export const ToolArtifactRecordSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    kind: z.string(),
    path: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const SessionEventSchema = z.object({
  type: z.literal("session"),
  session_id: z.string(),
});
export const TextEventSchema = z.object({ type: z.literal("text"), text: z.string() });
export const ReasoningEventSchema = z.object({ type: z.literal("reasoning"), text: z.string() });
export const ToolCallEventSchema = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()).nullish(),
  turn_index: z.number().optional(),
});
export const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  id: z.string(),
  name: z.string(),
  success: z.boolean(),
  summary: z.string().nullish(),
  data: z.record(z.unknown()).nullish(),
  error: z.string().nullish(),
  duration_ms: z.number().nullish(),
  artifacts: z.array(ToolArtifactRecordSchema).nullish(),
});
export const DoneEventSchema = z.object({
  type: z.literal("done"),
  status: z.enum(["ok", "exhausted", "failed"]),
  text: z.string().nullish(),
  final_video_url: z.string().nullish(),
  final_video_path: z.string().nullish(),
});
export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  fatal: z.boolean().optional(),
});

/** 诊断结论（server 发射；消费者：错题页/星图高亮归因链） */
export const DiagnosisEventSchema = z.object({
  type: z.literal("diagnosis"),
  attemptId: z.string(),
  rootNodeId: z.string(),
  misconceptionId: z.string().optional(),
  confidence: z.number().min(0).max(1),
  chain: z.array(z.string()),
});

/** 复习到期（server 发射；消费者：web「今日任务」徽标与组卷器） */
export const ReviewDueEventSchema = z.object({
  type: z.literal("review_due"),
  learnerId: z.string(),
  count: z.number().int().min(0),
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  SessionEventSchema,
  TextEventSchema,
  ReasoningEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  DoneEventSchema,
  ErrorEventSchema,
  DiagnosisEventSchema,
  ReviewDueEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const SseEnvelopeSchema = z.object({
  v: z.literal(2),
  seq: z.number().int().min(0),
  event: AgentEventSchema,
});
export type SseEnvelope = z.infer<typeof SseEnvelopeSchema>;
