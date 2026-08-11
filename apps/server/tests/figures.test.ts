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
