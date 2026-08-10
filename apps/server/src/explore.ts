/**
 * P5 探索伙伴（ExploreAgent）：自由 tool-calling 循环。
 * 宪法：苏格拉底式只引导不喂答案；图谱事实必须经工具查证（防幻觉）。
 * 首版两个工具：graph_query（节点档案）、find_similar（离线相关匹配）。
 * LLM 不可用时返回固定引导语（离线兜底，永不 500）。
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
import { effectiveLearnerId, type AppState } from "./app.js";

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

const EXPLORE_TOOLS: ToolDefinition[] = [
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
  {
    name: "find_similar",
    description: "根据一段文字（孩子的问题或想法）找到相关的知识点与经典题型名称。",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要匹配的文字" } },
      required: ["text"],
    },
  },
];

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

function buildSystemPrompt(knowledge: Knowledge, level?: string, nodeId?: string): string {
  const focus = nodeId ? knowledge.index.getNode(nodeId) : undefined;
  const levelLine = level
    ? `学生年级：${LEVEL_LABEL[level] ?? level}。解释和追问都不要超出这个年级的认知上限。`
    : "学生年级未知，按小学高年级的认知水平交流。";
  const focusLine = focus
    ? `当前聚焦的知识点：「${focus.name}」（id: ${focus.id}）。可以先用 graph_query 查它的档案再展开。`
    : "";
  return `你是「探索伙伴」——陪孩子在数学星图里自由漫游的同伴，不是讲课老师。
${levelLine}
${focusLine}
守则（必须遵守）：
1. 苏格拉底式：用追问引导孩子自己想明白，每次回复以一个能推进思考的好问题结尾。
2. 绝对不直接给出任何题目的答案或完整解法；孩子要答案时，把问题拆小再反问。
3. 需要图谱事实（节点关系、相关题型）时用工具 graph_query / find_similar 查证，绝不编造。
4. 语言面向孩子：短句、真诚鼓励；每次回复不超过 5 句话，禁止使用 LaTeX 公式记号（不要写 $...$、\\times、\\frac），
   算式直接写成「1 × 0 = 0」这样的普通文字。
5. 孩子说出好想法时，提醒他/她可以「记下这个发现」。

讲清楚的标准（比守则更重要——回复前先自检）：
A. 一次只讲一条线索。不要把三种理由堆在一起；先抛出最能让孩子自己动手验证的那一个，剩下的等他回应后再说。
B. 例子必须是孩子能真的动手数一数、摆一摆、算一算的。像「0 块饼干分给 0 个小朋友」这种连大人都想不明白的场景是坏例子——
   宁可用「6 块饼干分给 3 个人」这种他能验证的具体例子，先建立规则，再问「那如果人数变成 0 呢？」让他自己撞到矛盾。
C. 先让孩子体验到「咦，说不通」，再谈结论。数学规则的道理来自它必须自洽，不是来自权威。
D. 结尾的问题要小、要具体、要可回答。别问「你觉得会有什么麻烦吗」这种大而空的问题，
   要问「那你觉得 6 ÷ 0 应该等于几？你能找到一个数乘以 0 得到 6 吗？」这种他能立刻试的问题。`;
}

// ---------------------------------------------------------------------------
// Agent 循环
// ---------------------------------------------------------------------------

function defaultClientFactory(): ExploreClient {
  const config = loadLlmConfig(process.env);
  const endpoint = config.fast;
  return new LlmClient({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model,
  });
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

  const learner = state.repo.getLearner(input.learnerId);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(state.knowledge, learner?.level, input.nodeId) },
    ...input.messages.map((m): ChatMessage => ({ role: m.role, content: m.content })),
  ];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let text = "";
      let toolCalls: { id: string; name: string; argumentsJson: string }[] = [];
      for await (const ev of client.chat(messages, {
        tools: EXPLORE_TOOLS,
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
