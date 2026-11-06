import { describe, expect, it } from "vitest";
import {
  LlmClient,
  LlmHttpError,
  LocalOnlyViolationError,
  type LlmAuditEvent,
  type LlmStreamEvent,
  type StreamDone,
} from "../src/index.js";

function sseBody(chunks: unknown[]): string {
  return (
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function okResponse(chunks: unknown[]): Response {
  return new Response(sseBody(chunks), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function contentChunk(content: string, finish: string | null = null): unknown {
  return { choices: [{ delta: { content }, finish_reason: finish }] };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(
  responses: Array<Response | Error>,
): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("fetch queue exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchFn, calls };
}

function makeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

async function collect(gen: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const MESSAGES = [{ role: "user" as const, content: "solve 2x=6" }];

describe("LlmClient.chat", () => {
  it("streams text/reasoning/done events from a successful response", async () => {
    const { fetchFn, calls } = makeFetch([
      okResponse([
        contentChunk("<think>hmm</think>"),
        contentChunk("x = 3", "stop"),
      ]),
    ]);
    const client = new LlmClient({
      baseUrl: "http://localhost:1234/v1/",
      model: "qwen3-test",
      fetch: fetchFn,
    });

    const events = await collect(client.chat(MESSAGES));
    const done = events.at(-1) as StreamDone;
    expect(done.type).toBe("done");
    expect(done.text).toBe("x = 3");
    expect(done.reasoning).toBe("hmm");

    // request wiring
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/chat/completions");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("qwen3-test");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: "user", content: "solve 2x=6" }]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer lm-studio");
  });

  it("retries 502/503 with exponential backoff 1s/2s then succeeds", async () => {
    const { fetchFn, calls } = makeFetch([
      new Response("bad gateway", { status: 502 }),
      new Response("unavailable", { status: 503 }),
      okResponse([contentChunk("ok", "stop")]),
    ]);
    const { sleep, delays } = makeSleep();
    const client = new LlmClient({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      fetch: fetchFn,
      sleep,
    });

    const events = await collect(client.chat(MESSAGES));
    expect((events.at(-1) as StreamDone).text).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("retries network errors and gives up after maxRetries with the last error", async () => {
    const netErr = new TypeError("fetch failed");
    const { fetchFn, calls } = makeFetch([netErr, netErr, netErr, netErr]);
    const { sleep, delays } = makeSleep();
    const client = new LlmClient({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      fetch: fetchFn,
      sleep,
    });

    await expect(collect(client.chat(MESSAGES))).rejects.toBe(netErr);
    expect(calls).toHaveLength(4); // 1 initial + 3 retries
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("does not retry non-transient HTTP errors (400)", async () => {
    const { fetchFn, calls } = makeFetch([
      new Response('{"error": "bad request"}', { status: 400 }),
    ]);
    const { sleep, delays } = makeSleep();
    const client = new LlmClient({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      fetch: fetchFn,
      sleep,
    });

    const err = await collect(client.chat(MESSAGES)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).status).toBe(400);
    expect((err as LlmHttpError).body).toContain("bad request");
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("recovers Hermes tool calls when no visible text / native tool_calls", async () => {
    const { fetchFn } = makeFetch([
      okResponse([
        contentChunk(
          '<tool_call><function=render_video>{"scene": "Balance"}</function></tool_call>',
          "stop",
        ),
      ]),
    ]);
    const client = new LlmClient({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      fetch: fetchFn,
    });

    const events = await collect(client.chat(MESSAGES));
    const tool = events.find((e) => e.type === "tool_call");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ name: "render_video" });
    expect(JSON.parse((tool as { argumentsJson: string }).argumentsJson)).toEqual({
      scene: "Balance",
    });
    const done = events.at(-1) as StreamDone;
    expect(done.toolCalls).toHaveLength(1);
  });

  it("sends tools in OpenAI format and disables thinking by default", async () => {
    const { fetchFn, calls } = makeFetch([okResponse([contentChunk("ok", "stop")])]);
    const client = new LlmClient({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      fetch: fetchFn,
    });

    await collect(
      client.chat(MESSAGES, {
        tools: [
          {
            name: "solve",
            description: "Solve a problem",
            parameters: { type: "object", properties: { p: { type: "string" } } },
          },
        ],
      }),
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "solve",
          description: "Solve a problem",
          parameters: { type: "object", properties: { p: { type: "string" } } },
        },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("respects an explicit enable_thinking in extraBody over the tools default", async () => {
    const { fetchFn, calls } = makeFetch([okResponse([contentChunk("ok", "stop")])]);
    const client = new LlmClient({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      fetch: fetchFn,
    });

    await collect(
      client.chat(MESSAGES, {
        tools: [{ name: "solve" }],
        extraBody: { chat_template_kwargs: { enable_thinking: true } },
      }),
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("serializes assistant tool_calls and tool result messages to wire format", async () => {
    const { fetchFn, calls } = makeFetch([okResponse([contentChunk("ok", "stop")])]);
    const client = new LlmClient({
      baseUrl: "http://localhost:1234/v1",
      model: "m",
      fetch: fetchFn,
    });

    await collect(
      client.chat([
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "c1", name: "solve", argumentsJson: '{"p":"2x=6"}' }],
        },
        { role: "tool", content: "x=3", toolCallId: "c1", name: "solve" },
      ]),
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "solve", arguments: '{"p":"2x=6"}' } },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: "x=3",
      tool_call_id: "c1",
      name: "solve",
    });
  });
});

describe("LOCAL_ONLY：默认拒绝越界，放行时留审计", () => {
  it("默认（不传 localOnly）拿到云端地址直接构造失败——默认值在安全的那一侧", () => {
    expect(() => new LlmClient({ baseUrl: "https://api.example.com/v1", model: "m" })).toThrow(
      LocalOnlyViolationError,
    );
  });

  it("本地与局域网都放行", () => {
    for (const baseUrl of ["http://localhost:1234/v1", "http://127.0.0.1:8888/v1", "http://192.168.1.9:8000/v1", "http://my-box.local/v1"]) {
      expect(() => new LlmClient({ baseUrl, model: "m" })).not.toThrow();
    }
  });

  it("显式 LOCAL_ONLY=0 才放行云端，且每次请求都记一条审计（不含 apiKey）", async () => {
    const events: LlmAuditEvent[] = [];
    const client = new LlmClient({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-secret",
      model: "cloud-model",
      localOnly: false,
      audit: (e) => events.push(e),
      fetch: async () =>
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    });

    const chunks: string[] = [];
    for await (const ev of client.chat([{ role: "user", content: "x" }])) {
      if (ev.type === "text") chunks.push(ev.text);
    }

    expect(chunks.join("")).toBe("hi");
    expect(events).toHaveLength(1);
    expect(events[0]!.baseUrl).toBe("https://api.example.com/v1");
    expect(events[0]!.model).toBe("cloud-model");
    expect(JSON.stringify(events[0])).not.toContain("sk-secret");
  });

  it("本地请求不记审计（否则审计表里全是噪声，越界那几条就看不见了）", async () => {
    const events: LlmAuditEvent[] = [];
    const client = new LlmClient({
      baseUrl: "http://localhost:1234/v1",
      model: "local",
      audit: (e) => events.push(e),
      fetch: async () => new Response(`data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }),
    });
    for await (const _ of client.chat([{ role: "user", content: "x" }])) {
      // 读空
    }
    expect(events).toEqual([]);
  });
});
