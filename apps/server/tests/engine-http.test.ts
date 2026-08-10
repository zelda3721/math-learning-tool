import { describe, expect, it } from "vitest";
import http from "node:http";
import { createEngineFetch } from "../src/engineHttp.js";

/** 起一个本地引擎替身，返回基址与关闭函数 */
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("引擎 HTTP 客户端（绕开 undici 的 300 秒 headersTimeout）", () => {
  it("POST JSON 能正常往返", async () => {
    let seen: { method?: string; body?: string; ctype?: string } = {};
    const s = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen = {
          method: req.method,
          body: Buffer.concat(chunks).toString(),
          ctype: req.headers["content-type"],
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", plan_id: "p1" }));
      });
    });
    try {
      const f = createEngineFetch({ timeoutMs: 5000 });
      const resp = await f(`${s.base}/api/v1/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ problem: "题", route: "html" }),
      });
      expect(resp.ok).toBe(true);
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ status: "ok", plan_id: "p1" });
      expect(seen.method).toBe("POST");
      expect(seen.ctype).toBe("application/json");
      expect(JSON.parse(seen.body!).route).toBe("html");
    } finally {
      await s.close();
    }
  });

  it("首字节等很久也不断——这正是内置 fetch 做不到的那件事", async () => {
    const s = await serve((_req, res) => {
      // 模拟模型写码：迟迟不给响应头
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      }, 600);
    });
    try {
      const f = createEngineFetch({ timeoutMs: 5000 });
      const resp = await f(`${s.base}/api/v1/plan`, { method: "POST", body: "{}" });
      expect(((await resp.json()) as { status: string }).status).toBe("ok");
    } finally {
      await s.close();
    }
  });

  it("非 2xx 照常返回，由调用方判断", async () => {
    const s = await serve((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "busy" }));
    });
    try {
      const f = createEngineFetch({ timeoutMs: 5000 });
      const resp = await f(`${s.base}/api/v1/plan`, { method: "POST", body: "{}" });
      expect(resp.ok).toBe(false);
      expect(resp.status).toBe(503);
    } finally {
      await s.close();
    }
  });

  it("超过整体上限时给出可读原因，而不是一句 fetch failed", async () => {
    const s = await serve(() => {
      /* 永不响应 */
    });
    try {
      const f = createEngineFetch({ timeoutMs: 120 });
      await expect(f(`${s.base}/api/v1/plan`, { method: "POST", body: "{}" })).rejects.toThrow(
        /引擎请求失败.*未完成/,
      );
    } finally {
      await s.close();
    }
  });

  it("引擎没监听时说清是连接被拒绝", async () => {
    const f = createEngineFetch({ timeoutMs: 3000 });
    // 端口 1 上不会有服务
    await expect(f("http://127.0.0.1:1/api/v1/plan", { method: "POST", body: "{}" })).rejects.toThrow(
      /引擎未监听|ECONNREFUSED|引擎请求失败/,
    );
  });
})
