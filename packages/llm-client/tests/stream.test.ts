import { describe, expect, it } from "vitest";
import {
  chunksToEvents,
  normalizeArgumentsJson,
  parseSseStream,
  type LlmStreamEvent,
  type StreamDone,
} from "../src/index.js";

function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function contentChunk(content: string, finish: string | null = null): unknown {
  return { choices: [{ delta: { content }, finish_reason: finish }] };
}

async function* fromPieces(
  pieces: Array<string | Uint8Array>,
): AsyncGenerator<string | Uint8Array> {
  for (const p of pieces) yield p;
}

async function collect(gen: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function collectRaw(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("parseSseStream", () => {
  it("parses data: lines into JSON payloads and stops at [DONE]", async () => {
    const text =
      sseLine(contentChunk("Hello")) +
      sseLine(contentChunk(" world", "stop")) +
      "data: [DONE]\n\n" +
      sseLine(contentChunk("IGNORED AFTER DONE"));
    const payloads = await collectRaw(parseSseStream(fromPieces([text])));
    expect(payloads).toHaveLength(2);
  });

  it("reassembles lines split across arbitrary byte boundaries", async () => {
    const full = sseLine(contentChunk("你好，世界", "stop")) + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(full);
    // split in the middle of a multi-byte character region
    const mid = Math.floor(bytes.length / 2);
    const payloads = await collectRaw(
      parseSseStream(fromPieces([bytes.slice(0, mid), bytes.slice(mid)])),
    );
    expect(payloads).toHaveLength(1);
    const delta = (payloads[0] as { choices: Array<{ delta: { content: string } }> })
      .choices[0]!.delta;
    expect(delta.content).toBe("你好，世界");
  });

  it("skips non-data lines, empty data, and malformed JSON", async () => {
    const text =
      ": comment\n" +
      "event: message\n" +
      "data:\n" +
      "data: {broken json\n" +
      sseLine(contentChunk("ok", "stop"));
    const payloads = await collectRaw(parseSseStream(fromPieces([text])));
    expect(payloads).toHaveLength(1);
  });

  it("handles CRLF line endings and a final line without newline", async () => {
    const text =
      `data: ${JSON.stringify(contentChunk("a"))}\r\n\r\n` +
      `data: ${JSON.stringify(contentChunk("b", "stop"))}`; // no trailing \n
    const payloads = await collectRaw(parseSseStream(fromPieces([text])));
    expect(payloads).toHaveLength(2);
  });
});

describe("chunksToEvents", () => {
  async function* chunks(items: unknown[]): AsyncGenerator<unknown> {
    for (const c of items) yield c;
  }

  it("splits <think> spanning deltas into reasoning + text events", async () => {
    const events = await collect(
      chunksToEvents(
        chunks([
          contentChunk("<th"),
          contentChunk("ink>let me think</th"),
          contentChunk("ink>The answer is 4."),
          contentChunk("", "stop"),
        ]),
      ),
    );
    const reasoning = events
      .filter((e) => e.type === "reasoning")
      .map((e) => e.text)
      .join("");
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join("");
    expect(reasoning).toBe("let me think");
    expect(text).toBe("The answer is 4.");
    const done = events.at(-1) as StreamDone;
    expect(done.type).toBe("done");
    expect(done.finishReason).toBe("stop");
    expect(done.text).toBe("The answer is 4.");
    expect(done.reasoning).toBe("let me think");
  });

  it("routes delta.reasoning_content to the reasoning channel", async () => {
    const events = await collect(
      chunksToEvents(
        chunks([
          { choices: [{ delta: { reasoning_content: "step 1" } }] },
          { choices: [{ delta: { reasoning_content: ", step 2" } }] },
          { choices: [{ delta: { content: "final" }, finish_reason: "stop" }] },
        ]),
      ),
    );
    const done = events.at(-1) as StreamDone;
    expect(done.reasoning).toBe("step 1, step 2");
    expect(done.text).toBe("final");
    expect(events.filter((e) => e.type === "reasoning")).toHaveLength(2);
  });

  it("assembles native tool calls streamed across deltas by index", async () => {
    const events = await collect(
      chunksToEvents(
        chunks([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_abc", function: { name: "solve", arguments: '{"pro' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: 'blem": "1+1"}' } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );
    const tool = events.find((e) => e.type === "tool_call");
    expect(tool).toEqual({
      type: "tool_call",
      id: "call_abc",
      name: "solve",
      argumentsJson: '{"problem": "1+1"}',
    });
    const done = events.at(-1) as StreamDone;
    expect(done.finishReason).toBe("tool_calls");
    expect(done.toolCalls).toHaveLength(1);
  });

  it("falls back to a generated id and {} arguments", async () => {
    const events = await collect(
      chunksToEvents(
        chunks([
          {
            choices: [
              { delta: { tool_calls: [{ index: 2, function: { name: "ping" } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );
    const tool = events.find((e) => e.type === "tool_call");
    expect(tool).toEqual({
      type: "tool_call",
      id: "call_2",
      name: "ping",
      argumentsJson: "{}",
    });
  });

  it("recovers Hermes tool calls from text when no native calls appear", async () => {
    const events = await collect(
      chunksToEvents(
        chunks([
          contentChunk('I will call it now: <tool_call>{"name": "solve", '),
          contentChunk('"arguments": {"problem": "2x=6"}}</tool_call>', "stop"),
        ]),
      ),
    );
    const tool = events.find((e) => e.type === "tool_call");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ name: "solve" });
    expect(JSON.parse((tool as { argumentsJson: string }).argumentsJson)).toEqual({
      problem: "2x=6",
    });
  });

  it("promotes reasoning to done.text on finish_reason=length with no visible text", async () => {
    const events = await collect(
      chunksToEvents(
        chunks([
          contentChunk("<think>partial derivation 2x = 6 so x = 3"),
          { choices: [{ delta: {}, finish_reason: "length" }] },
        ]),
      ),
    );
    const done = events.at(-1) as StreamDone;
    expect(done.finishReason).toBe("length");
    expect(done.text).toBe("partial derivation 2x = 6 so x = 3");
    expect(done.reasoning).toBe("partial derivation 2x = 6 so x = 3");
  });
});

describe("normalizeArgumentsJson", () => {
  it("keeps valid object JSON as-is", () => {
    expect(normalizeArgumentsJson('{"a": 1}')).toBe('{"a": 1}');
  });

  it("wraps non-object JSON values", () => {
    expect(JSON.parse(normalizeArgumentsJson('"foo"'))).toEqual({ _value: "foo" });
    expect(JSON.parse(normalizeArgumentsJson("[1,2]"))).toEqual({ _value: [1, 2] });
  });

  it("wraps invalid JSON with _raw/_parse_error", () => {
    expect(JSON.parse(normalizeArgumentsJson("{oops"))).toEqual({
      _raw: "{oops",
      _parse_error: true,
    });
  });

  it("empty string becomes {}", () => {
    expect(normalizeArgumentsJson("")).toBe("{}");
  });
});
