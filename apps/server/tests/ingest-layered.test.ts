/**
 * 分层抽取的两个端点。
 *
 * 这里守的是分层最容易悄悄退化的那几处：
 * 配图只在版面说有图时才跑（否则每道题白烧一次调用）、
 * 配图失败只丢图不丢题、以及跨页 carryOver 真的传到了模型手上。
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ExtractedDraft, ExtractionProvider } from "../src/ingest/extraction.js";
import { parseLayout, type LayoutItem } from "../src/ingest/passes.js";
import { tempFixtureEnv } from "./helpers.js";

function jsonPost(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PAGE = "data:image/jpeg;base64,QUJD";

const LAYOUT_JSONL = [
  '{"index":1,"label":"练习1","preview":"一个长方形长8厘米","box":[0.08,0.1,0.95,0.3],"hasFigure":true,"continued":false}',
  '{"index":2,"label":"练习2","preview":"在一条100米长的小路","box":[0.08,0.4,0.95,0.6],"hasFigure":false,"continued":false}',
].join("\n");

interface Spy {
  layoutCalls: number;
  questionCalls: { carryOver?: string }[];
  figureCalls: number;
}

/**
 * 分层假 provider。layoutRaw/figure 可注入，用来演模型的各种不配合。
 * 注意这里刻意**不**实现 extractFromText/Image 之外的旧路径行为差异——
 * 分层与整页兜底是两条独立的路。
 */
function layeredProvider(opts: {
  layout?: LayoutItem[];
  figure?: unknown;
  figureThrows?: boolean;
  questionReturns?: ExtractedDraft | null;
}): ExtractionProvider & { spy: Spy } {
  const spy: Spy = { layoutCalls: 0, questionCalls: [], figureCalls: 0 };
  return {
    spy,
    async extractFromText() {
      return [];
    },
    async extractFromImage() {
      return [];
    },
    async layoutFromImage() {
      spy.layoutCalls += 1;
      return opts.layout ?? [];
    },
    async questionFromImage(_b, _m, hint) {
      spy.questionCalls.push({ carryOver: hint?.carryOver });
      if (opts.questionReturns !== undefined) return opts.questionReturns;
      return {
        stem: "一个长方形长 8 厘米、宽 5 厘米，它的周长是多少厘米？",
        answer: "26",
        answerType: "numeric",
        difficulty: 1,
        level: "elementary_lower",
      };
    },
    async figureFromImage() {
      spy.figureCalls += 1;
      if (opts.figureThrows) throw new Error("视觉端点超时");
      return opts.figure;
    },
  };
}

describe("POST /api/v1/ingest/layout", () => {
  it("返回切好的题与框的可用率", async () => {
    const env = tempFixtureEnv([]);
    // 走真实解析，别让测试里的 fixture 和线上格式各活各的
    env.state.extraction = layeredProvider({ layout: parseLayout(LAYOUT_JSONL) });
    const app = createApp(env.state);

    const res = await jsonPost(app, "/api/v1/ingest/layout", { content: PAGE });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.quality).toEqual({ total: 2, withBox: 2, ratio: 1 });
  });

  it("端点不支持分层时明说，让前端去走整页兜底", async () => {
    const env = tempFixtureEnv([]);
    env.state.extraction = {
      async extractFromText() {
        return [];
      },
      async extractFromImage() {
        return [];
      },
    };
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/layout", { content: PAGE });
    expect(res.status).toBe(501);
  });
});

describe("POST /api/v1/ingest/question", () => {
  /**
   * 抽取阶段**不再要配图规格**。原图才是配图的主表示：它就是原图，
   * 不存在重新理解的风险，而模型转写的「点线角」是二手的——
   * 已经见过它把直角梯形画成上下颠倒、对着数图形的网格给出 52 个点。
   * 规格留到真要做讲解动画时再从原图转。
   */
  it("即便版面说这题有图，也不再跑配图那趟", async () => {
    const env = tempFixtureEnv([]);
    const provider = layeredProvider({});
    env.state.extraction = provider;
    const app = createApp(env.state);

    await jsonPost(app, "/api/v1/ingest/question", { content: PAGE, hasFigure: true });
    expect(provider.spy.figureCalls).toBe(0);
  });

  it("跨页的上半截原样交给模型去拼", async () => {
    const env = tempFixtureEnv([]);
    const provider = layeredProvider({});
    env.state.extraction = provider;
    const app = createApp(env.state);

    await jsonPost(app, "/api/v1/ingest/question", {
      content: PAGE,
      hasFigure: false,
      carryOver: "小明从家出发，先向东走 300 米，",
    });
    expect(provider.spy.questionCalls[0]!.carryOver).toBe("小明从家出发，先向东走 300 米，");
  });

  it("这一块读不出题时说清楚，而不是返回一道空题", async () => {
    const env = tempFixtureEnv([]);
    env.state.extraction = layeredProvider({ questionReturns: null });
    const app = createApp(env.state);

    const res = await jsonPost(app, "/api/v1/ingest/question", { content: PAGE, hasFigure: false });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft).toBeNull();
    expect(body.warnings[0]).toContain("没读出题目");
  });

  it("识别出来的题照样过知识点定位", async () => {
    const env = tempFixtureEnv([]);
    env.state.extraction = layeredProvider({});
    const app = createApp(env.state);

    const res = await jsonPost(app, "/api/v1/ingest/question", { content: PAGE, hasFigure: false });
    const body = await res.json();
    expect(body.draft.suggestedNodeIds).toContain("perimeter");
  });
});

describe("答案出处", () => {
  it("模型说答案是自己算的，就标出来给家长核对", async () => {
    const env = tempFixtureEnv([]);
    env.state.extraction = layeredProvider({
      questionReturns: {
        stem: "下图的手绢里共有多少个三角形？",
        answer: "48",
        answerType: "numeric",
        difficulty: 3,
        level: "elementary_upper",
        answerUnverified: true,
      },
    });
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/question", { content: PAGE, hasFigure: false });
    expect((await res.json()).draft.answerUnverified).toBe(true);
  });
});

/**
 * 跨页的后半截。
 *
 * 实测第12讲 p4：整页 79% 的篇幅是上一页那道题的【解析】（七张分图 + 计数），
 * 版面那趟一条都没输出——它把整块当成了"纯讲解文字"。改提示词斗不过
 * "不是题就别输出"那条规则，而这块内容偏偏藏着上一页那道题的答案。
 * 所以另开一条路：前端按"第一道题从哪儿开始"算出这块区域，单独送来读。
 */
describe("POST /api/v1/ingest/tail", () => {
  function tailProvider(tail: unknown): ExtractionProvider & { seen: string[] } {
    const seen: string[] = [];
    return {
      seen,
      async extractFromText() {
        return [];
      },
      async extractFromImage() {
        return [];
      },
      async tailFromImage(_b, _m, carryOver) {
        seen.push(carryOver ?? "");
        return tail as never;
      },
    };
  }

  it("读出上一页那道题的答案与解析", async () => {
    const env = tempFixtureEnv([]);
    env.state.extraction = tailProvider({
      answer: "54",
      analysis: "按底和高分类枚举",
      hasFigure: true,
    });
    const app = createApp(env.state);
    const res = await jsonPost(app, "/api/v1/ingest/tail", { content: PAGE, carryOver: "数三角形" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tail.answer).toBe("54");
    expect(body.tail.hasFigure).toBe(true);
  });

  it("上一页的题干原样交给模型——它得知道这段解析在讲哪道题", async () => {
    const env = tempFixtureEnv([]);
    const provider = tailProvider({ answer: "54", hasFigure: false });
    env.state.extraction = provider;
    const app = createApp(env.state);
    await jsonPost(app, "/api/v1/ingest/tail", { content: PAGE, carryOver: "面积为2的三角形有几个" });
    expect(provider.seen[0]).toBe("面积为2的三角形有几个");
  });

  it("端点不支持时明说，别让前端以为读到了空答案", async () => {
    const env = tempFixtureEnv([]);
    env.state.extraction = {
      async extractFromText() {
        return [];
      },
      async extractFromImage() {
        return [];
      },
    };
    const app = createApp(env.state);
    expect((await jsonPost(app, "/api/v1/ingest/tail", { content: PAGE })).status).toBe(501);
  });
});
