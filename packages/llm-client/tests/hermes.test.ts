import { describe, expect, it } from "vitest";
import { parseHermesToolCalls } from "../src/index.js";

describe("parseHermesToolCalls", () => {
  it("returns [] when there is no <tool_call> marker", () => {
    expect(parseHermesToolCalls("just a normal answer")).toEqual([]);
  });

  it("parses shape 1: <function=NAME>{json}</function>", () => {
    const text =
      'before <tool_call><function=solve_problem>{"problem": "1+1", "grade": 3}</function></tool_call> after';
    const calls = parseHermesToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: "hermes_0",
      name: "solve_problem",
      arguments: { problem: "1+1", grade: 3 },
    });
  });

  it("parses shape 1 with empty args", () => {
    const text = "<tool_call><function=list_patterns></function></tool_call>";
    const calls = parseHermesToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("list_patterns");
    expect(calls[0]!.arguments).toEqual({});
  });

  it("parses shape 2: bare JSON object with name/arguments", () => {
    const text =
      '<tool_call>{"name": "render_video", "arguments": {"scene": "Balance", "quality": "medium"}}</tool_call>';
    const calls = parseHermesToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: "hermes_json_0",
      name: "render_video",
      arguments: { scene: "Balance", quality: "medium" },
    });
  });

  it("parses shape 2 with function/args key aliases", () => {
    const text =
      '<tool_call>{"function": "inspect", "args": {"frame": 3}}</tool_call>';
    const calls = parseHermesToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("inspect");
    expect(calls[0]!.arguments).toEqual({ frame: 3 });
  });

  it("tolerates bad JSON in shape 1 as {_raw, _parse_error}", () => {
    const text =
      "<tool_call><function=solve>{not valid json</function></tool_call>";
    const calls = parseHermesToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toEqual({
      _raw: "{not valid json",
      _parse_error: true,
    });
  });

  it("coerces non-object JSON args in shape 1 to {_value}", () => {
    const text = '<tool_call><function=echo>"just a string"</function></tool_call>';
    const calls = parseHermesToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toEqual({ _value: "just a string" });
  });

  it("skips bad JSON / non-dict payloads in shape 2", () => {
    const text =
      "<tool_call>{broken}</tool_call>" +
      '<tool_call>{"name": "ok", "arguments": {}}</tool_call>';
    const calls = parseHermesToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("ok");
  });

  it("skips shape-2 payloads without a string name", () => {
    const text = '<tool_call>{"arguments": {"a": 1}}</tool_call>';
    expect(parseHermesToolCalls(text)).toEqual([]);
  });

  it("de-dupes identical calls across both shapes", () => {
    const text =
      '<tool_call><function=solve>{"a": 1, "b": 2}</function></tool_call>' +
      '<tool_call>{"name": "solve", "arguments": {"b": 2, "a": 1}}</tool_call>';
    const calls = parseHermesToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("hermes_0");
  });

  it("keeps distinct calls with different arguments", () => {
    const text =
      '<tool_call><function=solve>{"a": 1}</function></tool_call>' +
      '<tool_call><function=solve>{"a": 2}</function></tool_call>';
    const calls = parseHermesToolCalls(text);
    expect(calls).toHaveLength(2);
  });
});
