/**
 * 拍照识题（问一道题 / 讲解共用的 /ask/photo/* 面）与带图提问。
 *
 * 守的是三条纪律：
 * ① photo/question 只回题干——照片上印着的答案（教师版/同学的作答）绝不能
 *    成为判卷依据，答案必须走 Solve→Verify；
 * ② 带图提问时，图要落盘、跟着题目入库，并且解题请求里要有 figure_image
 *    （几何/统计题不看图解不出正确答案）；
 * ③ 自由文本讲解带图时，引擎 plan 请求里同样要有 figure_image。
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import type { EngineContract } from "@mathtutor/schema";
import { createApp } from "../src/app.js";
import { parseOrientation, type ExtractionProvider } from "../src/ingest/extraction.js";
import type { LayoutItem } from "../src/ingest/passes.js";
import { tempFixtureEnv } from "./helpers.js";

const CONTRACT: EngineContract = {
  contract_version: "open_world_v4",
  tools: [],
  event_types: [],
  artifact_url_base: "/api/v1/media",
};

/** 1×1 PNG：真能被 storeFigure 解出来的最小合法图 */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PHOTO = "data:image/jpeg;base64,QUJD";

/** 拍下来的那道题：题干框 0.1~0.6，配图在题干框内、答案线（0.6）之上 */
const PHOTO_ITEM: LayoutItem = {
  index: 1,
  label: "练习1",
  preview: "如图，求梯形面积",
  box: [0.05, 0.1, 0.95, 0.8],
  hasFigure: true,
  figureBox: [0.3, 0.2, 0.7, 0.5],
  continued: false,
  answerTop: 0.6,
};

function photoProvider(
  opts: { layout?: LayoutItem[]; stem?: string | null; rotate?: 0 | 90 | 180 | 270 } = {},
): ExtractionProvider {
  return {
    async extractFromText() {
      return [];
    },
    async extractFromImage() {
      return [];
    },
    async orientationFromImage() {
      return opts.rotate ?? 0;
    },
    async layoutFromImage() {
      return opts.layout ?? [PHOTO_ITEM];
    },
    async questionFromImage() {
      if (opts.stem === null) return null;
      return {
        stem: opts.stem ?? "如图，梯形上底 3、下底 5、高 4，面积是多少？",
        // 模型从教师版照片上读到了答案——它不许流出去
        answer: "16",
        answerType: "numeric",
        difficulty: 2,
        level: "elementary_upper",
      };
    },
  };
}

/** mock 引擎 plan-only，记录每次请求体（验证 figure_image 有没有带上） */
function mockPlan() {
  const calls: Record<string, unknown>[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("/api/v1/plan")) throw new Error(`unexpected url ${String(url)}`);
    calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        status: "ok",
        plan_id: "plan-photo-1",
        solution_answer: "16",
        solution_steps: ["(3+5)×4÷2 = 16"],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makePhotoApp(opts: { provider?: ExtractionProvider | null; engineFetch?: typeof fetch } = {}) {
  const env = tempFixtureEnv([]);
  env.state.contract = CONTRACT;
  env.state.extraction = opts.provider === undefined ? photoProvider() : opts.provider;
  if (opts.engineFetch) env.state.engineFetch = opts.engineFetch;
  // 默认 figuresDir 指向仓库工作目录——测试的图必须进临时目录
  env.state.config = { ...env.state.config, figuresDir: path.join(env.dataDir, "figures") };
  return { app: createApp(env.state), ...env };
}

async function post(app: ReturnType<typeof createApp>, url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function waitAskJob(app: ReturnType<typeof createApp>, jobId: string) {
  for (let i = 0; i < 50; i++) {
    const body = (await (await app.request(`/api/v1/ask/jobs/${jobId}`)).json()) as Record<string, any>;
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("ask job never settled");
}

describe("照片方向判定", () => {
  it("parseOrientation 取最后一个合法数字（模型可能先推理再给答案）", () => {
    expect(parseOrientation("270")).toBe(270);
    expect(parseOrientation("顺时针旋转 90 度")).toBe(90);
    expect(parseOrientation("不是 90，应该是 270。")).toBe(270);
    expect(parseOrientation("文字是正的，0 度")).toBe(0);
  });

  it("parseOrientation 判不出按 0（判错方向比不转危害大）", () => {
    expect(parseOrientation("")).toBe(0);
    expect(parseOrientation("看不清楚")).toBe(0);
    expect(parseOrientation("大概 45 度")).toBe(0);
  });

  it("POST /photo/orientation 返回该顺时针转的度数", async () => {
    const { app } = makePhotoApp({ provider: photoProvider({ rotate: 270 }) });
    const res = await post(app, "/api/v1/ask/photo/orientation", { content: PHOTO });
    expect(res.status).toBe(200);
    expect(res.body.rotate).toBe(270);
  });

  it("provider 不支持方向判定 → 501（前端按 0 继续，不拦流程）", async () => {
    const bare = photoProvider();
    delete (bare as Partial<ExtractionProvider>).orientationFromImage;
    const { app } = makePhotoApp({ provider: bare });
    const res = await post(app, "/api/v1/ask/photo/orientation", { content: PHOTO });
    expect(res.status).toBe(501);
  });
});

describe("POST /api/v1/ask/photo/layout", () => {
  it("返回切好的题，且配图已按结构判成题干图", async () => {
    const { app } = makePhotoApp();
    const res = await post(app, "/api/v1/ask/photo/layout", { content: PHOTO });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    // figureBox 在答案线之上 → 题干图；这正是前端裁图用的框
    expect(res.body.items[0].stemFigureBox).toEqual([0.3, 0.2, 0.7, 0.5]);
  });

  it("答案线之下的图判成解析图，不给孩子", async () => {
    const item: LayoutItem = { ...PHOTO_ITEM, figureBox: [0.3, 0.65, 0.7, 0.78] };
    const { app } = makePhotoApp({ provider: photoProvider({ layout: [item] }) });
    const res = await post(app, "/api/v1/ask/photo/layout", { content: PHOTO });
    expect(res.body.items[0].stemFigureBox).toBeUndefined();
    expect(res.body.items[0].analysisFigureBox).toEqual([0.3, 0.65, 0.7, 0.78]);
  });

  it("抽取端点没配置 → 501（可读的失败，不是 500）", async () => {
    const { app } = makePhotoApp({ provider: null });
    const res = await post(app, "/api/v1/ask/photo/layout", { content: PHOTO });
    expect(res.status).toBe(501);
  });

  it("光杆题号（页底只有下一题题号的窄条）下发 dangling，前端据此不当成多题", async () => {
    const stub: LayoutItem = {
      index: 2,
      label: "练习9",
      preview: "练习9",
      box: [0.05, 0.92, 0.95, 1],
      hasFigure: false,
      continued: false,
    };
    const { app } = makePhotoApp({ provider: photoProvider({ layout: [PHOTO_ITEM, stub] }) });
    const res = await post(app, "/api/v1/ask/photo/layout", { content: PHOTO });
    expect(res.body.items[0].dangling).toBe(false);
    expect(res.body.items[1].dangling).toBe(true);
  });

  it("超过 4MB 上限的照片 → 400，不进模型", async () => {
    const { app } = makePhotoApp();
    const res = await post(app, "/api/v1/ask/photo/layout", {
      content: `data:image/jpeg;base64,${"A".repeat(6_100_000)}`,
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/ask/photo/question", () => {
  it("只回题干，照片上读到的答案绝不下发", async () => {
    const { app } = makePhotoApp();
    const res = await post(app, "/api/v1/ask/photo/question", { content: PHOTO });
    expect(res.status).toBe(200);
    expect(res.body.stem).toContain("梯形");
    // 整个响应体里都不许出现答案——不只是没有 answer 字段
    expect(JSON.stringify(res.body)).not.toContain("16");
  });

  it("读不出题目时如实说，不编", async () => {
    const { app } = makePhotoApp({ provider: photoProvider({ stem: null }) });
    const res = await post(app, "/api/v1/ask/photo/question", { content: PHOTO });
    expect(res.body.stem).toBeNull();
    expect(res.body.warnings.length).toBeGreaterThan(0);
  });
});

describe("带图提问：图跟着题走，引擎解题也要看图", () => {
  it("figureImage 落盘、入库、下发，plan 请求带 figure_image", async () => {
    const plan = mockPlan();
    const { app, store, dataDir } = makePhotoApp({ engineFetch: plan.impl });
    const ask = await post(app, "/api/v1/ask", {
      problem: "如图，梯形上底 3、下底 5、高 4，面积是多少？",
      figureImage: TINY_PNG,
    });
    expect(ask.status).toBe(202);
    const job = await waitAskJob(app, ask.body.jobId);
    expect(job.status).toBe("done");

    // 图落盘 + 挂在题上 + 随题下发（练习卡靠它显示原图）
    expect(job.question.figureImage).toMatch(/\.png$/);
    expect(existsSync(path.join(dataDir, "figures", job.question.figureImage))).toBe(true);
    expect(store.byId.get(job.question.id)?.figureImage).toBe(job.question.figureImage);

    // 引擎解题请求里带了图：几何题不看图解不出正确答案
    expect(plan.calls).toHaveLength(1);
    expect(String(plan.calls[0]!.figure_image)).toMatch(/^data:image\/png;base64,/);
  });

  it("引擎载荷里 LaTeX 落成普通文字，题库存的原文保留 $（练习页有 KaTeX）", async () => {
    const plan = mockPlan();
    const { app, store } = makePhotoApp({ engineFetch: plan.impl });
    const stem = "如图，$E$为$AD$边的中点，三角形$ABE$的面积为$\\frac{1}{2}$平方厘米，求面积。";
    const ask = await post(app, "/api/v1/ask", { problem: stem });
    const job = await waitAskJob(app, ask.body.jobId);
    expect(job.status).toBe("done");
    // 引擎看到的：没有 $、分数已落成 1/2（讲解页没有 KaTeX，$ 会原样印出来）
    expect(plan.calls[0]!.problem).toBe("如图，E为AD边的中点，三角形ABE的面积为1/2平方厘米，求面积。");
    // 题库存的：原文一字不动
    expect(store.byId.get(job.question.id)?.stem).toBe(stem);
  });

  it("图存不下来当场 400，不进入几分钟的解题流程", async () => {
    const plan = mockPlan();
    const { app } = makePhotoApp({ engineFetch: plan.impl });
    const res = await post(app, "/api/v1/ask", {
      problem: "如图，梯形面积是多少？",
      figureImage: "data:image/png;base64,",
    });
    expect(res.status).toBe(400);
    expect(plan.calls).toHaveLength(0);
  });
});

describe("自由文本讲解带图：plan 请求带 figure_image", () => {
  it("problem + figureImage → 引擎收到图", async () => {
    const captured: Record<string, unknown>[] = [];
    const engineFetch = (async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes("/api/v1/plan")) throw new Error(`unexpected url ${String(url)}`);
      captured.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ status: "ok", plan_id: "plan-x", scene_spec: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { app } = makePhotoApp({ engineFetch });

    const res = await post(app, "/api/v1/explain", {
      problem: "如图，梯形上底 3、下底 5、高 4，面积是多少？",
      grade: "elementary_upper",
      figureImage: TINY_PNG,
      mode: "web",
    });
    expect(res.status).toBe(202);
    // 任务是异步的，等它把 plan 打出去
    for (let i = 0; i < 50 && captured.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(captured).toHaveLength(1);
    expect(String(captured[0]!.figure_image)).toMatch(/^data:image\/png;base64,/);
  });
});
