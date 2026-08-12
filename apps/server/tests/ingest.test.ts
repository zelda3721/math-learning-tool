import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ExtractedDraft, ExtractionProvider } from "../src/ingest/extraction.js";
import { parseExtractionJson, parseExtractionOutcome, segmentQuestionsOffline } from "../src/ingest/extraction.js";
import { tempFixtureEnv } from "./helpers.js";

function jsonPost(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const fakeDrafts: ExtractedDraft[] = [
  {
    stem: "一个长方形长 8 厘米、宽 5 厘米，它的周长是多少厘米？",
    answer: "26",
    answerType: "numeric",
    analysis: "(8+5)×2=26",
    difficulty: 1,
    level: "elementary_lower",
  },
  {
    stem: "在一条 100 米长的小路一侧植树，每隔 5 米栽一棵，两端都栽，一共栽多少棵？",
    answer: "21",
    answerType: "numeric",
    difficulty: 3,
    level: "elementary_upper",
  },
];

function fakeProvider(): ExtractionProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async extractFromText(text) {
      calls.push(`text:${text.length}`);
      return fakeDrafts;
    },
    async extractFromImage(base64, mime) {
      calls.push(`image:${mime}`);
      return fakeDrafts.slice(0, 1);
    },
  };
}

/** 手搓最小单页 PDF（Helvetica 文本层；text 为空则无文本层） */
function miniPdf(text: string): string {
  const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : "";
  const objs = [
    "",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = pdf.length;
    pdf += objs[i] + "\n";
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

describe("ingest upload", () => {
  it("text upload with fake provider returns located drafts", async () => {
    const env = tempFixtureEnv([]);
    env.state.extraction = fakeProvider();
    const app = createApp(env.state);

    const res = await jsonPost(app, "/api/v1/ingest/upload", {
      kind: "text",
      content: "1. 一个长方形长 8 厘米……",
      level: "elementary_lower",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drafts.length).toBe(2);
    expect(body.warnings).toEqual([]);
    // 周长题应被离线定位器建议 perimeter 知识点
    expect(body.drafts[0].suggestedNodeIds).toContain("perimeter");
    expect(body.drafts[0].confidence).toBeGreaterThan(0);
    // 植树题应命中植树问题题型
    expect(body.drafts[1].suggestedProblemTypeId).toBe("planting-trees");
    // 草稿绝不含 id/contentHash（不落库）
    expect(body.drafts[0].id).toBeUndefined();
    expect(body.drafts[0].contentHash).toBeUndefined();
  });

  it("text upload without provider falls back to offline segmentation", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);

    const content = [
      "练习一",
      "1. 小明有 25 个苹果，又买来 17 个，现在有多少个？",
      "2、一个正方形边长 7 厘米，周长是多少厘米？",
      "（3）每隔 5 米栽一棵树，100 米两端都栽，栽多少棵？",
    ].join("\n");
    const res = await jsonPost(app, "/api/v1/ingest/upload", { kind: "text", content });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drafts.length).toBe(3);
    expect(body.drafts.map((d: { answer: string }) => d.answer)).toEqual(["", "", ""]);
    expect(body.drafts[0].stem).toContain("25 个苹果");
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.warnings[0]).toContain("离线");
  });

  it("image upload without provider returns 501", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/upload", { kind: "image", content: "aGVsbG8=" });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toContain("LLM");
  });

  it("image upload passes mime from data URL to the provider", async () => {
    const env = tempFixtureEnv([]);
    const provider = fakeProvider();
    env.state.extraction = provider;
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/upload", {
      kind: "image",
      content: "data:image/png;base64,aGVsbG8=",
    });
    expect(res.status).toBe(200);
    expect(provider.calls).toEqual(["image:image/png"]);
    expect((await res.json()).drafts.length).toBe(1);
  });

  it("pdf upload extracts the text layer and feeds it to the provider", async () => {
    const env = tempFixtureEnv([]);
    const calls: string[] = [];
    env.state.extraction = {
      async extractFromText(text) {
        calls.push(text);
        return fakeDrafts.slice(0, 1);
      },
      async extractFromImage() {
        throw new Error("unexpected");
      },
    };
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/upload", {
      kind: "pdf",
      content: Buffer.from(miniPdf("Hello 123")).toString("base64"),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).drafts.length).toBe(1);
    expect(calls).toEqual(["Hello 123"]);
  });

  it("pdf without a text layer tells the user to photograph instead", async () => {
    const env = tempFixtureEnv([]);
    env.state.extraction = fakeProvider();
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/upload", {
      kind: "pdf",
      content: Buffer.from(miniPdf("")).toString("base64"),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("拍照");
  });

  it("pdf upload without provider returns 501", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/upload", {
      kind: "pdf",
      content: Buffer.from(miniPdf("x")).toString("base64"),
    });
    expect(res.status).toBe(501);
  });

  it("rejects malformed upload bodies", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/upload", { kind: "video", content: "x" });
    expect(res.status).toBe(400);
  });
});

describe("ingest confirm", () => {
  const confirmPayload = (nodeIds: string[]) => ({
    batchName: "unit-batch",
    questions: [
      {
        stem: "一个长方形长 8 厘米、宽 5 厘米，它的周长是多少厘米？",
        answer: "26",
        answerType: "numeric",
        analysis: "(8+5)×2=26",
        difficulty: 1,
        level: "elementary_lower",
        nodeIds,
      },
    ],
  });

  it("upload → confirm writes questions into the store; re-confirm dedupes", async () => {
    const env = tempFixtureEnv([]);
    env.state.extraction = fakeProvider();
    const app = createApp(env.state);

    const up = await jsonPost(app, "/api/v1/ingest/upload", { kind: "text", content: "材料" });
    const { drafts } = await up.json();

    const confirmBody = {
      batchName: "batch-一",
      questions: drafts.map((d: Record<string, unknown>) => ({
        stem: d.stem,
        answer: d.answer,
        answerType: d.answerType,
        analysis: d.analysis,
        difficulty: d.difficulty,
        level: d.level,
        nodeIds: (d.suggestedNodeIds as string[]).slice(0, 2),
        problemTypeId: d.suggestedProblemTypeId,
      })),
    };
    const res = await jsonPost(app, "/api/v1/ingest/confirm", confirmBody);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.written).toBe(2);
    expect(body.skippedDuplicates).toBe(0);
    expect(body.issues).toEqual([]);

    // store 重新加载后能查到，且元数据正确
    expect(env.store.all.length).toBe(2);
    const q = env.store.all.find((x) => x.stem.includes("周长"))!;
    expect(q.source.role).toBe("upload");
    expect(q.status).toBe("extracted");
    expect(q.contentHash).toHaveLength(16);
    expect(env.store.byNode.get(q.nodeIds[0]!)).toContainEqual(q);

    // 重复确认：全部按 contentHash 去重
    const res2 = await jsonPost(app, "/api/v1/ingest/confirm", confirmBody);
    const body2 = await res2.json();
    expect(body2.written).toBe(0);
    expect(body2.skippedDuplicates).toBe(2);
    expect(env.store.all.length).toBe(2);
  });

  it("rejects dangling nodeIds without writing", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/confirm", confirmPayload(["no-such-node"]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.written).toBe(0);
    expect(body.issues.length).toBe(1);
    expect(body.issues[0].problem).toContain("悬挂");
    expect(env.store.all.length).toBe(0);
  });

  it("rejects empty answers and missing batchName at the schema gate", async () => {
    const env = tempFixtureEnv([]);
    const app = createApp(env.state);
    const bad = confirmPayload(["perimeter"]);
    bad.questions[0]!.answer = "";
    expect((await jsonPost(app, "/api/v1/ingest/confirm", bad)).status).toBe(400);
    const noBatch = { ...confirmPayload(["perimeter"]), batchName: "" };
    expect((await jsonPost(app, "/api/v1/ingest/confirm", noBatch)).status).toBe(400);
  });
});

describe("extraction helpers", () => {
  it("segments numbered questions and drops the preamble", () => {
    const blocks = segmentQuestionsOffline(
      "第三单元练习\n1. 第一题的题干\n继续第一题\n2、第二题\n例3 第三题\n第4题 第四题\n（5）第五题",
    );
    expect(blocks.length).toBe(5);
    expect(blocks[0]).toBe("第一题的题干\n继续第一题");
    expect(blocks[4]).toBe("第五题");
  });

  it("treats unnumbered text as a single question", () => {
    expect(segmentQuestionsOffline("小明有 3 支铅笔，又买了 2 支，一共几支？")).toHaveLength(1);
  });

  it("parses fenced / noisy LLM JSON output leniently", () => {
    const raw = '好的，抽取结果如下：\n```json\n[{"stem":"1+1=?","answer":2,"difficulty":9},{"stem":""}]\n```';
    const drafts = parseExtractionJson(raw, "elementary_upper");
    expect(drafts.length).toBe(1);
    expect(drafts[0]).toMatchObject({ stem: "1+1=?", answer: "2", answerType: "numeric", difficulty: 5 });
    // 一个 { 都没有 = 这一页没题（封面、章节页、整页解析），不是失败。
    // 见下面「空白页不算失败」那一组
    expect(parseExtractionJson("完全不是 JSON", "middle")).toEqual([]);
  });
});

/**
 * 分层的内容趟只要一道题，实测模型就不再压成一行、而是 pretty-print 展开。
 * 按行解析这时会一无所获，必须落到括号配对那条路上——
 * 这不是假设，是 qwen3.6-27b 对着裁好的单题图给出的真实形状。
 */
describe("单题的多行 JSON", () => {
  it("pretty-print 的单个对象照样解析得出来", () => {
    const raw = [
      "{",
      '"stem": "已知平行四边形ABCD的面积是48平方厘米，高AE=8厘米，求CD是多少厘米？",',
      '"answer": "6",',
      '"answerType": "numeric",',
      '"options": [],',
      '"analysis": "根据平行四边形面积公式，底等于面积除以高，即 48 ÷ 8 = 6。",',
      '"difficulty": 1,',
      '"level": "elementary_upper"',
      "}",
    ].join("\n");
    const drafts = parseExtractionJson(raw, "elementary_upper");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.answer).toBe("6");
    expect(drafts[0]!.stem).toContain("平行四边形");
  });
});

/**
 * 「这一页没有题目」是正常情况，不是错误。
 *
 * 提示词自己就写着"材料里没有题目时什么都不输出"，封面页、章节页、
 * 整页解析都会走到这里。此前一律抛错，于是一本讲义里几张没题的页面
 * 就成了刺眼的红色报错——实机上是
 * 「第 8 页识别失败：LLM 输出里找不到任何 JSON 对象（材料中没有题目，不输出任何内容。）」。
 */
describe("空白页不算失败", () => {
  it.each([
    ["模型明说没有", "材料中没有题目，不输出任何内容。"],
    ["什么都没输出", ""],
    ["只有空白", "   \n  "],
  ])("%s → 返回空，不抛错", (_why, raw) => {
    const outcome = parseExtractionOutcome(raw, "elementary_upper");
    expect(outcome.drafts).toEqual([]);
    expect(outcome.empty).toBe(true);
  });

  it("写到一半断了仍然要报出来——那一页是真丢了", () => {
    expect(() => parseExtractionOutcome('{"stem":"一个长方形长 8 厘', "elementary_upper")).toThrow(
      /截断/,
    );
  });

  it("括号里的内容坏掉时不抛错，记进 skipped 让调用方提示", () => {
    // 有一对完整括号就抠得出块，坏的只是那一块——不该因此判定整页失败
    const outcome = parseExtractionOutcome("{stem: 没有引号}", "elementary_upper");
    expect(outcome.drafts).toEqual([]);
    expect(outcome.skipped).toBe(1);
    expect(outcome.empty).toBeUndefined();
  });

  it("有题目时照常解析", () => {
    const outcome = parseExtractionOutcome(
      '{"stem":"一个长方形长 8 厘米、宽 5 厘米，周长是多少？","answer":"26"}',
      "elementary_upper",
    );
    expect(outcome.drafts).toHaveLength(1);
    expect(outcome.empty).toBeUndefined();
  });
});
