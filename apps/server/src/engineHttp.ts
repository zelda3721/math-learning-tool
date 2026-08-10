/**
 * 面向引擎长任务的 HTTP 客户端。
 *
 * 为什么不用内置 fetch：Node 的 fetch 是 undici，它有一个**独立于 AbortSignal 的**
 * `headersTimeout`，默认 300 秒。让模型写一页讲解经常要 5–10 分钟，于是连接在
 * 第 5 分钟被 undici 自己掐断，抛出的还是信息全无的 `TypeError: fetch failed`——
 * 我们设的 `AbortSignal.timeout(600_000)` 压根管不到它。
 *
 * node:http 客户端默认不设首字节超时，超时策略完全由这里说了算；
 * 同时把底层原因（ECONNREFUSED / ECONNRESET / 超时）带进错误信息，
 * 而不是留下一句谁也查不动的 "fetch failed"。
 *
 * 只覆盖调用方实际用到的那部分 fetch 形态（status / ok / json / text），
 * 因为它只服务引擎的 JSON 端点。SSE 流式那条仍走内置 fetch，不受影响。
 */
import http from "node:http";
import https from "node:https";

export interface EngineFetchOptions {
  /** 整体上限：超过就主动断开并给出可读原因 */
  timeoutMs: number;
  /** 空闲上限：这么久没有任何数据才判定对端死了（默认取整体上限） */
  idleMs?: number;
}

/**
 * 造一个 fetch 形状的函数，专用于引擎的 JSON 端点。
 * 测试里注入的 `state.engineFetch` 优先，所以这层不影响任何既有用例。
 */
export function createEngineFetch(options: EngineFetchOptions): typeof fetch {
  const idleMs = options.idleMs ?? options.timeoutMs;

  return ((input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const client = url.protocol === "https:" ? https : http;
    const body = init?.body === undefined || init?.body === null ? undefined : String(init.body);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k] = v;
    }
    if (body !== undefined && headers["content-length"] === undefined) {
      headers["content-length"] = String(Buffer.byteLength(body));
    }

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string, cause?: unknown) => {
        if (settled) return;
        settled = true;
        request.destroy();
        clearTimeout(overall);
        reject(new Error(`引擎请求失败（${url.pathname}）：${reason}`, { cause }));
      };

      const request = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            if (settled) return;
            settled = true;
            clearTimeout(overall);
            const text = Buffer.concat(chunks).toString("utf8");
            resolve(
              new Response(text, {
                status: res.statusCode ?? 502,
                headers: Object.fromEntries(
                  Object.entries(res.headers).map(([k, v]) => [
                    k,
                    Array.isArray(v) ? v.join(", ") : String(v ?? ""),
                  ]),
                ),
              }),
            );
          });
          res.on("error", (err) => fail(`响应中断：${err.message}`, err));
        },
      );

      // 整体上限：模型写码可能要十几分钟，但不能没有尽头
      const overall = setTimeout(
        () => fail(`超过 ${Math.round(options.timeoutMs / 1000)} 秒未完成`),
        options.timeoutMs,
      );
      // 空闲上限：对端还活着就一直等；真死了才断
      request.setTimeout(idleMs, () => {
        fail(`连接空闲超过 ${Math.round(idleMs / 1000)} 秒`);
      });
      request.on("error", (err: NodeJS.ErrnoException) => {
        fail(err.code === "ECONNREFUSED" ? "引擎未监听（连接被拒绝）" : err.message, err);
      });

      if (body !== undefined) request.write(body);
      request.end();
    });
  }) as typeof fetch;
}

/** 引擎 JSON 端点的默认客户端：模型写码允许跑久，但 20 分钟仍不回就当它死了 */
export const engineJsonFetch = createEngineFetch({ timeoutMs: 20 * 60_000, idleMs: 20 * 60_000 });
