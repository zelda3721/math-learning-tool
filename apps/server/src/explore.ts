/**
 * 探索伙伴：自由 tool-calling 循环。
 *
 * 阶段 1 起，「这个学科该怎么带」不再写死在这里——它是一份技能文件
 * `skills/math/explore/SKILL.md`。本文件只剩与学科无关的部分：
 * 一轮 agent 循环、工具执行、离线兜底。
 *
 * 这么切的理由：每加一门学科就复制一份代理代码，而真正随学科变化的
 * 其实只有提示词与工具子集（见 docs/PLAN.md D10）。
 *
 * 宪法：苏格拉底式只引导不喂答案；图谱事实必须经工具查证（防幻觉）。
 * LLM 或技能文件不可用时返回固定引导语（离线兜底，永不 500）。
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  LlmClient,
  loadLlmConfig,
  type ChatMessage,
  type ChatOptions,
  type LlmStreamEvent,
  type ToolDefinition,
} from "@mathtutor/llm-client";
import { matchOffline, matchProblemTypesOffline, type Knowledge } from "@mathtutor/knowledge";
import { loadSkills, resolveSkill, type Skill } from "@mathtutor/core";
import { fileURLToPath } from "node:url";
import { effectiveLearnerId, type AppState } from "./app.js";
import { auditDataDir, createServerLlmClient } from "./llm.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 最小 LLM 客户端接口（可注入 fake 便于测试） */
export interface ExploreClient {
  chat(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<LlmStreamEvent>;
}

export type ExploreClientFactory = () => ExploreClient;

export interface ExploreInput {
  learnerId: string;
  nodeId?: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface ToolTraceEntry {
  name: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface ExploreResult {
  reply: string;
  toolTrace: ToolTraceEntry[];
}

/** 离线兜底引导语：LLM 挂掉也不能让孩子的好奇心落空 */
export const EXPLORE_FALLBACK_REPLY =
  "我这会儿联系不上思考引擎，不过我们可以先自己动脑：把你最好奇的那件事说成一个具体的问题，" +
  "再想想它和你已经会的哪个知识有点像？想到了就记下来，等会儿我们一起验证。";

/** 每次探索最多 4 轮 LLM 调用（工具循环上限） */
const MAX_ROUNDS = 4;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const TOOL_DEFS: Record<string, ToolDefinition> = {
  graph_query:
  {
    name: "graph_query",
    description:
      "查询知识星图中某个节点的档案：是什么、为什么学、会演化成什么、需要哪些前置、和谁相关。需要图谱事实时必须用它，不许编造。",
    parameters: {
      type: "object",
      properties: { nodeId: { type: "string", description: "知识点 id" } },
      required: ["nodeId"],
    },
  },
  find_similar: {
    name: "find_similar",
    description: "根据一段文字（孩子的问题或想法）找到相关的知识点与经典题型名称。",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要匹配的文字" } },
      required: ["text"],
    },
  },
};

/**
 * 技能声明用哪些工具，就只把哪些交给模型。
 * 全量交给模型再指望它别用，等于用提示词做权限控制——那件事从来没有成功过。
 */
export function toolsFor(skill: Skill): ToolDefinition[] {
  const picked: ToolDefinition[] = [];
  for (const name of skill.tools) {
    const def = TOOL_DEFS[name];
    if (def) picked.push(def);
    else console.warn(`[explore] 技能 ${skill.id} 声明了未实现的工具 ${name}，已忽略`);
  }
  return picked;
}

function executeTool(
  knowledge: Knowledge,
  name: string,
  args: Record<string, unknown>,
): { result: unknown; summary: string } {
  if (name === "graph_query") {
    const nodeId = String(args["nodeId"] ?? "");
    const node = knowledge.index.getNode(nodeId);
    if (!node) {
      return { result: { error: `图谱里没有节点 ${nodeId}` }, summary: `查询未知节点 ${nodeId}` };
    }
    const nameOf = (id: string) => knowledge.index.getNode(id)?.name ?? id;
    return {
      result: {
        name: node.name,
        whatIsIt: node.whatIsIt ?? node.summary,
        why: node.why ?? "",
        evolvesTo: node.evolvesTo.map((e) => ({ to: nameOf(e.to), how: e.how })),
        prerequisites: node.prerequisites.map(nameOf),
        relatedTo: node.relatedTo.map(nameOf),
      },
      summary: `查了知识点「${node.name}」`,
    };
  }
  if (name === "find_similar") {
    const text = String(args["text"] ?? "");
    const nodes = matchOffline(knowledge.index, text, 5).map(
      (m) => knowledge.index.getNode(m.id)?.name ?? m.id,
    );
    const problems = matchProblemTypesOffline(knowledge.problemTypes, text, 3).map(
      (m) => knowledge.problemTypes.find((p) => p.id === m.id)?.name ?? m.id,
    );
    // 题型名（如「鸡兔同笼」）辨识度高，摘要里优先展示
    const hits = [...problems.slice(0, 2), ...nodes.slice(0, 3)];
    return {
      result: { relatedNodes: nodes, relatedProblemTypes: problems },
      summary: hits.length ? `找相关：${hits.join("、")}` : "找相关：暂无命中",
    };
  }
  // 未知工具：宽容返回（LLM 幻觉出的工具名不该让整轮失败）
  return { result: { error: `未知工具 ${name}` }, summary: `调用了未知工具 ${name}` };
}

// ---------------------------------------------------------------------------
// 系统提示（宪法）
// ---------------------------------------------------------------------------

const LEVEL_LABEL: Record<string, string> = {
  elementary_lower: "小学低年级",
  elementary_upper: "小学高年级",
  middle: "初中",
  high: "高中",
  advanced: "大学",
};

/**
 * 技能文件是按需读的：一份写坏或找不到的技能，不该让整个服务起不来。
 * 读一次缓存住——提示词不会在运行中变。
 */
const SKILLS_ROOT = fileURLToPath(new URL("../../../skills", import.meta.url));
let cachedSkills: Skill[] | null = null;

export function exploreSkill(): Skill | undefined {
  cachedSkills ??= loadSkills(SKILLS_ROOT);
  return resolveSkill(cachedSkills, "math", "explore");
}

/**
 * 组装系统提示：**技能文件是提示词的唯一来源**，这里只补上随会话变化的上下文
 * （年级、当前聚焦的知识点）。
 *
 * 不把提示词内嵌回代码里当兜底——那会立刻变成第二份真相：
 * 有人改了 SKILL.md，线上跑的却是那一份旧的，而且没有任何地方会报错。
 */
export function buildSystemPrompt(
  knowledge: Knowledge,
  skill: Skill,
  level?: string,
  nodeId?: string,
): string {
  const focus = nodeId ? knowledge.index.getNode(nodeId) : undefined;
  const context = [
    level
      ? `学生年级：${LEVEL_LABEL[level] ?? level}。解释和追问都不要超出这个年级的认知上限。`
      : "学生年级未知，按小学高年级的认知水平交流。",
    focus
      ? `当前聚焦的知识点：「${focus.name}」（id: ${focus.id}）。可以先用 graph_query 查它的档案再展开。`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return skill.body.includes("{{context}}")
    ? skill.body.replace("{{context}}", context)
    : `${context}\n\n${skill.body}`;
}

// ---------------------------------------------------------------------------
// Agent 循环
// ---------------------------------------------------------------------------

function defaultClientFactory(): ExploreClient {
  const config = loadLlmConfig(process.env);
  return createServerLlmClient(config, "fast", { dataDir: auditDataDir(process.env) });
}

function safeParseArgs(argumentsJson: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(argumentsJson);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runExplore(
  state: Pick<AppState, "knowledge" | "repo">,
  input: ExploreInput,
  clientFactory?: ExploreClientFactory,
): Promise<ExploreResult> {
  const toolTrace: ToolTraceEntry[] = [];

  let client: ExploreClient;
  try {
    client = (clientFactory ?? defaultClientFactory)();
  } catch {
    return { reply: EXPLORE_FALLBACK_REPLY, toolTrace };
  }

  // 没有技能文件就没有提示词可讲——照兜底语回复，而不是用一份临时拼的话术顶上
  const skill = exploreSkill();
  if (!skill) {
    console.warn("[explore] 找不到技能 skills/math/explore/SKILL.md");
    return { reply: EXPLORE_FALLBACK_REPLY, toolTrace };
  }
  const tools = toolsFor(skill);

  const learner = state.repo.getLearner(input.learnerId);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt(state.knowledge, skill, learner?.level, input.nodeId),
    },
    ...input.messages.map((m): ChatMessage => ({ role: m.role, content: m.content })),
  ];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let text = "";
      let toolCalls: { id: string; name: string; argumentsJson: string }[] = [];
      for await (const ev of client.chat(messages, {
        tools,
        temperature: 0.5,
        maxTokens: 900,
      })) {
        if (ev.type === "done") {
          text = ev.text;
          toolCalls = ev.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            argumentsJson: tc.argumentsJson,
          }));
        }
      }

      if (toolCalls.length === 0) {
        const reply = text.trim();
        return { reply: reply || EXPLORE_FALLBACK_REPLY, toolTrace };
      }

      // 有工具调用：执行 → 以 role:'tool' 消息续跑
      messages.push({ role: "assistant", content: text, toolCalls });
      for (const tc of toolCalls) {
        const args = safeParseArgs(tc.argumentsJson);
        const { result, summary } = executeTool(state.knowledge, tc.name, args);
        toolTrace.push({ name: tc.name, args, summary });
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          toolCallId: tc.id,
          name: tc.name,
        });
      }
    }
    // 轮次耗尽仍在要工具：交出兜底语（已查到的 toolTrace 保留）
    return { reply: EXPLORE_FALLBACK_REPLY, toolTrace };
  } catch {
    return { reply: EXPLORE_FALLBACK_REPLY, toolTrace };
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const ChatSchema = z.object({
  learnerId: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) }))
    .min(1),
});

/** POST /chat → {reply, toolTrace}；AppState 不改，LlmClient 由本路由自建 */
export function exploreRoutes(state: AppState, clientFactory?: ExploreClientFactory): Hono {
  const app = new Hono();

  app.post("/chat", async (c) => {
    const parsed = ChatSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId 与 messages" }, 400);
    parsed.data.learnerId = effectiveLearnerId(c, state, parsed.data.learnerId) ?? parsed.data.learnerId;
    const result = await runExplore(state, parsed.data, clientFactory);
    return c.json(result);
  });

  return app;
}
