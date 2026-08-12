/**
 * 题目原图的存取。
 *
 * 原图是配图的主表示，所以这条路上的每个环节都得钉住：
 * 落盘、取回、路径穿越、以及删题之后不留孤儿。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { isSafeFigureName, loadFigure, pruneFigures, storeFigure } from "../src/figures.js";
import { tempFixtureEnv, NODE_A } from "./helpers.js";

/** 1×1 的 JPEG，够真实地走完 base64 → 落盘 → 取回 */
const TINY_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL" +
  "DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

/** 1×1 的 PNG，用来和 JPEG 区分开——两张图不能互相覆盖 */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "figures-"));
}

describe("storeFigure", () => {
  it("落盘并返回文件名", () => {
    const dir = tempDir();
    const stored = storeFigure(dir, TINY_JPEG);
    expect(stored.name).toMatch(/^[a-f0-9]{32}\.jpg$/);
    expect(existsSync(path.join(dir, stored.name))).toBe(true);
    expect(stored.bytes).toBeGreaterThan(0);
  });

  it("同一张图重复导入不会在磁盘上堆出好几份", () => {
    const dir = tempDir();
    const a = storeFigure(dir, TINY_JPEG);
    const b = storeFigure(dir, TINY_JPEG);
    expect(a.name).toBe(b.name);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it.each([
    ["不是 data URL", "https://example.com/a.jpg"],
    ["不是图片", "data:text/html;base64,PGgxPmhp"],
    ["空内容", "data:image/jpeg;base64,"],
  ])("拒收：%s", (_why, raw) => {
    expect(() => storeFigure(tempDir(), raw)).toThrow();
  });

  it("超过上限时说清楚多大，而不是只说失败", () => {
    const big = `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`;
    expect(() => storeFigure(tempDir(), big)).toThrow(/超过 4MB/);
  });
});

describe("loadFigure", () => {
  it("取回时带上正确的 Content-Type", () => {
    const dir = tempDir();
    const { name } = storeFigure(dir, TINY_JPEG);
    expect(loadFigure(dir, name)?.contentType).toBe("image/jpeg");
  });

  it("文件不存在返回 null", () => {
    expect(loadFigure(tempDir(), "0".repeat(32) + ".jpg")).toBeNull();
  });

  /** 服务端凭文件名读盘，名字放宽一点就是任人读走整个磁盘 */
  it.each([
    ["上跳目录", "../../../etc/passwd"],
    ["斜杠", "sub/dir.jpg"],
    ["绝对路径", "/etc/hosts"],
    ["空字节", "a\0.jpg"],
    ["扩展名不在白名单", "abc.svg"],
  ])("拒绝危险的文件名：%s", (_why, name) => {
    expect(isSafeFigureName(name)).toBe(false);
    expect(loadFigure(tempDir(), name)).toBeNull();
  });
});

describe("pruneFigures", () => {
  it("删掉没人引用的，留下还在用的", () => {
    const dir = tempDir();
    const keep = storeFigure(dir, TINY_JPEG);
    writeFileSync(path.join(dir, "0".repeat(32) + ".jpg"), "orphan");
    expect(pruneFigures(dir, new Set([keep.name]))).toBe(1);
    expect(readdirSync(dir)).toEqual([keep.name]);
  });

  it("目录不存在时不报错", () => {
    expect(pruneFigures(path.join(tempDir(), "nope"), new Set())).toBe(0);
  });

  it("不认识的文件不碰——那目录里可能有别人的东西", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "README.txt"), "hi");
    expect(pruneFigures(dir, new Set())).toBe(0);
    expect(readdirSync(dir)).toEqual(["README.txt"]);
  });
});

describe("入库 → 取图 → 删题", () => {
  const question = {
    stem: "下图中三角形 ABC 的面积是多少？",
    answer: "6",
    answerType: "numeric" as const,
    difficulty: 2,
    level: "elementary_upper" as const,
    nodeIds: [NODE_A],
    figureImage: TINY_JPEG,
  };

  it("确认入库时把原图落盘，之后可以按 URL 取回", async () => {
    const env = tempFixtureEnv([]);
    env.state.config.figuresDir = tempDir();
    const app = createApp(env.state);

    const res = await app.request("/api/v1/ingest/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchName: "t", questions: [question] }),
    });
    expect((await res.json()).written).toBe(1);

    const stored = env.state.questions.all.find((q) => q.stem === question.stem);
    expect(stored?.figureImage).toMatch(/\.jpg$/);
    // 存的是文件名而不是那一大坨 base64——题库 JSON 不该被二进制撑爆
    expect(stored?.figureImage?.length).toBeLessThan(64);

    const img = await app.request(`/api/v1/figures/${stored!.figureImage}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("图坏掉时只丢图不丢题", async () => {
    const env = tempFixtureEnv([]);
    env.state.config.figuresDir = tempDir();
    const app = createApp(env.state);

    const res = await app.request("/api/v1/ingest/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchName: "t",
        questions: [{ ...question, figureImage: "data:text/plain;base64,aGk=" }],
      }),
    });
    const body = await res.json();
    expect(body.written).toBe(1);
    expect(body.issues[0].problem).toContain("原图未能保存");
  });

  it("取一张不存在的图给 404，而不是 500", async () => {
    const env = tempFixtureEnv([]);
    env.state.config.figuresDir = tempDir();
    const app = createApp(env.state);
    expect((await app.request(`/api/v1/figures/${"0".repeat(32)}.jpg`)).status).toBe(404);
  });

  it("删掉题之后原图跟着清掉，不留孤儿", async () => {
    const env = tempFixtureEnv([]);
    const dir = tempDir();
    env.state.config.figuresDir = dir;
    const app = createApp(env.state);

    await app.request("/api/v1/ingest/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchName: "t", questions: [question] }),
    });
    expect(readdirSync(dir)).toHaveLength(1);

    const id = env.state.questions.all.find((q) => q.stem === question.stem)!.id;
    const del = await app.request(`/api/v1/bank/questions/${id}`, { method: "DELETE" });
    expect((await del.json()).prunedFigures).toBe(1);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

/**
 * 解析图这条线：入库、展示给家长、交给讲解——但**绝不下发给做题中的孩子**。
 *
 * 那张图往往就是解法本身（「所求阴影部分面积等于下图中阴影部分面积」），
 * 一给出来这道题就没了。而它泄漏出去不会报错，只会表现为"孩子这题做得真快"。
 */
describe("解析图只在讲解时用", () => {
  const question = {
    stem: "两个相同的直角梯形重叠在一起，求阴影部分的面积。",
    answer: "100",
    answerType: "numeric" as const,
    difficulty: 3,
    level: "elementary_upper" as const,
    nodeIds: [NODE_A],
    figureImage: TINY_JPEG,
    analysisImage: TINY_PNG,
  };

  async function seed() {
    const env = tempFixtureEnv([]);
    env.state.config.figuresDir = tempDir();
    const app = createApp(env.state);
    await app.request("/api/v1/ingest/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchName: "t", questions: [question] }),
    });
    return { env, app };
  }

  it("两张图分别落盘，互不覆盖", async () => {
    const { env } = await seed();
    const q = env.state.questions.all.find((x) => x.stem === question.stem)!;
    expect(q.figureImage).toMatch(/\.jpg$/);
    expect(q.analysisImage).toMatch(/\.png$/);
    expect(q.analysisImage).not.toBe(q.figureImage);
  });

  it("练习下发的题面里没有解析图", async () => {
    const { env, app } = await seed();
    const learner = env.repo.createLearner("小明", "elementary_upper");
    const res = await app.request("/api/v1/practice/today", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learnerId: learner.id }),
    });
    const body = await res.text();
    const q = env.state.questions.all.find((x) => x.stem === question.stem)!;
    // 题干图可以出现，解析图一个字都不许有
    expect(body).not.toContain(q.analysisImage!);
    expect(body).not.toContain("analysisImage");
  });

  it("删题时两张图一起清掉，不留孤儿", async () => {
    const { env, app } = await seed();
    const dir = env.state.config.figuresDir;
    expect(readdirSync(dir)).toHaveLength(2);
    const id = env.state.questions.all.find((x) => x.stem === question.stem)!.id;
    const del = await app.request(`/api/v1/bank/questions/${id}`, { method: "DELETE" });
    expect((await del.json()).prunedFigures).toBe(2);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

/**
 * 分类器错了，家长要能就地纠正。
 *
 * 分类判据是版面结构，而讲义排版千奇百怪，总会有判错的时候——
 * 而错的方向恰恰危险：一张答案表挂成题干图，孩子一打开就看见答案。
 * 抽检时看得出来就该能一键改，不该为一张图去重跑十分钟推理
 * （何况查重会把重传的题当成重复挡掉，重跑也修不好）。
 */
describe("改判图的归属", () => {
  async function seeded(fields: Record<string, unknown>) {
    const env = tempFixtureEnv([]);
    env.state.config.figuresDir = tempDir();
    const app = createApp(env.state);
    await app.request("/api/v1/ingest/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batchName: "t",
        questions: [
          {
            stem: "三个和尚分水，最初大和尚有多少升？",
            answer: "10",
            answerType: "numeric",
            difficulty: 3,
            level: "elementary_upper",
            nodeIds: [NODE_A],
            ...fields,
          },
        ],
      }),
    });
    const q = env.state.questions.all[0]!;
    return { env, app, id: q.id, before: q };
  }

  async function patch(app: ReturnType<typeof createApp>, id: string, body: unknown) {
    return app.request(`/api/v1/bank/questions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("题干图改判为解析图后，孩子就看不到它了", async () => {
    const { env, app, id, before } = await seeded({ figureImage: TINY_JPEG });
    const res = await patch(app, id, { moveFigureToAnalysis: true });
    expect(res.status).toBe(200);
    const after = env.state.questions.byId.get(id)!;
    expect(after.figureImage).toBeUndefined();
    expect(after.analysisImage).toBe(before.figureImage);
  });

  it("反过来也能改：解析图其实是题干的一部分", async () => {
    const { env, app, id, before } = await seeded({ analysisImage: TINY_JPEG });
    await patch(app, id, { moveAnalysisToFigure: true });
    const after = env.state.questions.byId.get(id)!;
    expect(after.figureImage).toBe(before.analysisImage);
    expect(after.analysisImage).toBeUndefined();
  });

  it("改判之后图还在盘上——它只是换了个身份，不该被当孤儿清掉", async () => {
    const { env, app, id } = await seeded({ figureImage: TINY_JPEG });
    await patch(app, id, { moveFigureToAnalysis: true });
    const after = env.state.questions.byId.get(id)!;
    expect(loadFigure(env.state.config.figuresDir, after.analysisImage!)).not.toBeNull();
  });

  it("不传这两个开关时两张图都不动", async () => {
    const { env, app, id, before } = await seeded({
      figureImage: TINY_JPEG,
      analysisImage: TINY_PNG,
    });
    await patch(app, id, { difficulty: 4 });
    const after = env.state.questions.byId.get(id)!;
    expect(after.figureImage).toBe(before.figureImage);
    expect(after.analysisImage).toBe(before.analysisImage);
  });
});
