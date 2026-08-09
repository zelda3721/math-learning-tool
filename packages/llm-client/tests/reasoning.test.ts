import { describe, expect, it } from "vitest";
import {
  ReasoningSplitter,
  extractReasoningContent,
  promoteTruncatedReasoning,
} from "../src/index.js";

/** Feed all chunks then flush; return total visible/reasoning strings. */
function run(chunks: string[]): { visible: string; reasoning: string } {
  const splitter = new ReasoningSplitter();
  let visible = "";
  let reasoning = "";
  for (const c of chunks) {
    const r = splitter.feed(c);
    visible += r.visible;
    reasoning += r.reasoning;
  }
  const tail = splitter.flush();
  visible += tail.visible;
  reasoning += tail.reasoning;
  return { visible, reasoning };
}

describe("ReasoningSplitter", () => {
  it("handles a complete <think> block inside one chunk", () => {
    const r = run(["Hello <think>secret plan</think> world"]);
    expect(r.visible).toBe("Hello  world");
    expect(r.reasoning).toBe("secret plan");
  });

  it("handles the open tag split across chunks (<th + ink>)", () => {
    const r = run(["<th", "ink>deep thought</think>answer"]);
    expect(r.visible).toBe("answer");
    expect(r.reasoning).toBe("deep thought");
  });

  it("handles the close tag split across chunks (</th + ink>)", () => {
    const r = run(["<think>abc</th", "ink>done"]);
    expect(r.visible).toBe("done");
    expect(r.reasoning).toBe("abc");
  });

  it("handles the open tag split one char at a time", () => {
    const r = run(["<", "t", "h", "i", "n", "k", ">", "r</think>v"]);
    expect(r.visible).toBe("v");
    expect(r.reasoning).toBe("r");
  });

  it("passes through text with no think tags", () => {
    const r = run(["Just a plain ", "streamed answer."]);
    expect(r.visible).toBe("Just a plain streamed answer.");
    expect(r.reasoning).toBe("");
  });

  it("holds back a partial-tag-looking tail until flush", () => {
    const splitter = new ReasoningSplitter();
    const first = splitter.feed("result <thi");
    // The last len("<think>")-1 = 6 chars ("t <thi") are held back because
    // they could be the start of "<think>" — same semantics as the Python
    // splitter.
    expect(first.visible).toBe("resul");
    const second = splitter.feed("ng that is not a tag");
    const tail = splitter.flush();
    expect(first.visible + second.visible + tail.visible).toBe(
      "result <thing that is not a tag",
    );
    expect(tail.reasoning).toBe("");
  });

  it("routes an unclosed <think> tail to reasoning on flush", () => {
    const r = run(["<think>never closed because tokens ran out"]);
    expect(r.visible).toBe("");
    expect(r.reasoning).toBe("never closed because tokens ran out");
  });

  it("handles multiple think blocks in a stream", () => {
    const r = run(["a<think>1</think>b<thi", "nk>2</thin", "k>c"]);
    expect(r.visible).toBe("abc");
    expect(r.reasoning).toBe("12");
  });
});

describe("extractReasoningContent (delta.reasoning_content channel)", () => {
  it("extracts reasoning_content when present", () => {
    expect(extractReasoningContent({ reasoning_content: "thinking..." })).toBe(
      "thinking...",
    );
  });

  it("returns empty for missing / non-string / null delta", () => {
    expect(extractReasoningContent({ content: "hi" })).toBe("");
    expect(extractReasoningContent({ reasoning_content: 42 })).toBe("");
    expect(extractReasoningContent(null)).toBe("");
    expect(extractReasoningContent(undefined)).toBe("");
  });
});

describe("promoteTruncatedReasoning (finish_reason=length)", () => {
  it("promotes reasoning to text when length-truncated with no visible text", () => {
    const r = promoteTruncatedReasoning("length", "  ", "partial reasoning");
    expect(r.promoted).toBe(true);
    expect(r.text).toBe("partial reasoning");
    expect(r.reasoning).toBe("partial reasoning");
  });

  it("does not promote when visible text exists", () => {
    const r = promoteTruncatedReasoning("length", "answer", "reasoning");
    expect(r.promoted).toBe(false);
    expect(r.text).toBe("answer");
  });

  it("does not promote on finish_reason=stop", () => {
    const r = promoteTruncatedReasoning("stop", "", "reasoning");
    expect(r.promoted).toBe(false);
    expect(r.text).toBe("");
  });

  it("does not promote when reasoning is empty", () => {
    const r = promoteTruncatedReasoning("length", "", "   ");
    expect(r.promoted).toBe(false);
  });
});
