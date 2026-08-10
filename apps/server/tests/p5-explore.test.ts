import { describe, expect, it } from "vitest";
import type { ChatMessage, LlmStreamEvent } from "@mathtutor/llm-client";
import {
  runExplore,
  EXPLORE_FALLBACK_REPLY,
  type ExploreClient,
} from "../src/explore.js";
import { listNotes, saveNote, slugify } from "../src/notes.js";
import { makeQuestion, tempFixtureEnv, knowledge, NODE_A, NODE_B } from "./helpers.js";
import { createApp } from "../src/app.js";

const NODE_A_NAME = knowledge.index.getNode(NODE_A)!.name;

function makeEnv() {
  const env = tempFixtureEnv([makeQuestion({ id: "eq1" })]);
  const learner = env.repo.createLearner("小探", "elementary_upper");
  return { ...env, learner };
}

// ---------------------------------------------------------------------------
// notes：file-first 存取
// ---------------------------------------------------------------------------

describe("P5 research notes (file-first)", () => {
  it("saveNote/listNotes 往返 + 按 nodeId 过滤", () => {
    const { dataDir } = makeEnv();
    const a = saveNote(dataDir, {
      learnerId: "learner-1",
      nodeId: NODE_A,
      title: "我的发现：分数像切蛋糕",
      contentMd: "# 发现\n分数就是把 1 切开。",
    });
    const b = saveNote(dataDir, {
      learnerId: "learner-1",
      nodeId: NODE_B,
      title: "第二个发现",
      contentMd: "别的内容",
    });
    expect(a.slug).not.toBe(b.slug);

    const all = listNotes(dataDir, "learner-1");
    expect(all).toHaveLength(2);
    const byNode = listNotes(dataDir, "learner-1", NODE_A);
    expect(byNode).toHaveLength(1);
    expect(byNode[0]!.title).toBe("我的发现：分数像切蛋糕");
    expect(byNode[0]!.contentMd).toContain("分数就是把 1 切开");
    expect(byNode[0]!.nodeId).toBe(NODE_A);
    expect(byNode[0]!.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 其他 learner 看不到
    expect(listNotes(dataDir, "learner-2")).toHaveLength(0);
  });

  it("slug 由标题规范化 + 随机后缀构成；标题无可用字符时退化为 note", () => {
    expect(slugify("勾股定理 大发现!")).toMatch(/^勾股定理-大发现-[0-9a-f]{6}$/);
    expect(slugify("!!!")).toMatch(/^note-[0-9a-f]{6}$/);
  });

  it("routes：POST /api/v1/notes + GET 过滤", async () => {
    const env = makeEnv();
    const app = createApp(env.state);
    const post = await app.request("/api/v1/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        learnerId: env.learner.id,
        nodeId: NODE_A,
        title: "路由笔记",
        contentMd: "内容",
      }),
    });
    expect(post.status).toBe(200);
    const posted = await post.json();
    expect(posted.ok).toBe(true);
    expect(typeof posted.slug).toBe("string");

    const list = await app.request(
      `/api/v1/notes?learnerId=${encodeURIComponent(env.learner.id)}&nodeId=${NODE_A}`,
    );
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].slug).toBe(posted.slug);
    expect(body.notes[0].title).toBe("路由笔记");

    // 缺 learnerId → 400；缺字段 → 400
    expect((await app.request("/api/v1/notes")).status).toBe(400);
    const bad = await app.request("/api/v1/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId: env.learner.id }),
    });
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// explore：tool-calling 循环（注入 fake client）
// ---------------------------------------------------------------------------

/** fake：第一轮要求 graph_query，第二轮读到工具结果后回复 */
function fakeToolClient(log: ChatMessage[][]): ExploreClient {
  let call = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *chat(messages: ChatMessage[]): AsyncGenerator<LlmStreamEvent> {
      log.push(messages);
      call++;
      if (call === 1) {
        yield {
          type: "done",
          finishReason: "tool_calls",
          text: "",
          reasoning: "",
          toolCalls: [
            {
              type: "tool_call",
              id: "tc-1",
              name: "graph_query",
              argumentsJson: JSON.stringify({ nodeId: NODE_A }),
            },
          ],
        };
        return;
      }
      yield { type: "text", text: "" };
      yield {
        type: "done",
        finishReason: "stop",
        text: `你觉得「${NODE_A_NAME}」和你昨天玩的拼图有什么像的地方？`,
        reasoning: "",
        toolCalls: [],
      };
    },
  };
}

describe("P5 explore agent", () => {
  it("tool_call → 执行 graph_query → tool 消息续跑 → 最终回复与 toolTrace", async () => {
    const env = makeEnv();
    const log: ChatMessage[][] = [];
    const result = await runExplore(
      env.state,
      {
        learnerId: env.learner.id,
        nodeId: NODE_A,
        messages: [{ role: "user", content: "这个知识点有什么好玩的？" }],
      },
      () => fakeToolClient(log),
    );

    expect(result.reply).toContain(NODE_A_NAME);
    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0]!.name).toBe("graph_query");
    expect(result.toolTrace[0]!.args).toEqual({ nodeId: NODE_A });
    expect(result.toolTrace[0]!.summary).toContain(NODE_A_NAME);

    // 第二轮消息里必须带 assistant(toolCalls) + role:'tool' 的工具结果
    expect(log).toHaveLength(2);
    const second = log[1]!;
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolCallId).toBe("tc-1");
    expect(String(toolMsg!.content)).toContain(NODE_A_NAME);
    // 系统提示是宪法：苏格拉底式 + 年级
    expect(String(second[0]!.content)).toContain("追问");
    expect(String(second[0]!.content)).toContain("小学高年级");
  });

  it("LLM 构造失败 → 固定引导语兜底", async () => {
    const env = makeEnv();
    const result = await runExplore(
      env.state,
      { learnerId: env.learner.id, messages: [{ role: "user", content: "你好" }] },
      () => {
        throw new Error("no llm configured");
      },
    );
    expect(result.reply).toBe(EXPLORE_FALLBACK_REPLY);
    expect(result.toolTrace).toHaveLength(0);
  });

  it("LLM 调用中途失败 → 兜底且保留已完成的 toolTrace", async () => {
    const env = makeEnv();
    let call = 0;
    const flaky: ExploreClient = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *chat(): AsyncGenerator<LlmStreamEvent> {
        call++;
        if (call === 1) {
          yield {
            type: "done",
            finishReason: "tool_calls",
            text: "",
            reasoning: "",
            toolCalls: [
              {
                type: "tool_call",
                id: "tc-x",
                name: "find_similar",
                argumentsJson: JSON.stringify({ text: "鸡兔同笼" }),
              },
            ],
          };
          return;
        }
        throw new Error("connection reset");
      },
    };
    const result = await runExplore(
      env.state,
      { learnerId: env.learner.id, messages: [{ role: "user", content: "鸡兔同笼是什么" }] },
      () => flaky,
    );
    expect(result.reply).toBe(EXPLORE_FALLBACK_REPLY);
    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0]!.name).toBe("find_similar");
    expect(result.toolTrace[0]!.summary).toContain("鸡兔同笼");
  });

  it("route：缺 messages → 400", async () => {
    const env = makeEnv();
    const app = createApp(env.state);
    const res = await app.request("/api/v1/explore/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ learnerId: env.learner.id }),
    });
    expect(res.status).toBe(400);
  });
});
