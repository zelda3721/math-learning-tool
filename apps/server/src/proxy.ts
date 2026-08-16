import type { Context } from "hono";
import { request as httpRequest } from "node:http";

/**
 * 引擎反向代理：透传请求体与 SSE 流。
 * 学生设备只连 server；server 是引擎的唯一调用方（注入 learner_id 的位置）。
 *
 * 用 node:http 而不是内置 fetch：undici 的 bodyTimeout 默认 300 秒**静默**就
 * 掐断响应流（UND_ERR_BODY_TIMEOUT）。本地模型的长阶段（solve/direct/compile）
 * 一步就要跑几分钟、期间 SSE 一声不吭——实机上视频生成到一半流被斩断，
 * 前端只看到流悄悄结束，永远停在"生成中"。node:http 没有这个隐藏计时器。
 */
export async function proxyToEngine(c: Context, engineUrl: string): Promise<Response> {
  const url = new URL(c.req.url);
  const target = new URL(engineUrl + url.pathname + url.search);

  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  // 请求体整体读入：这里只有 JSON（含 data URL 配图，几 MB 级），不必流式
  const body = hasBody ? Buffer.from(await c.req.raw.arrayBuffer()) : undefined;

  const headers: Record<string, string> = {};
  const contentType = c.req.header("content-type");
  if (contentType) headers["content-type"] = contentType;
  const accept = c.req.header("accept");
  if (accept) headers["accept"] = accept;
  if (body) headers["content-length"] = String(body.length);

  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      target,
      { method, headers },
      (res) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on("end", () => {
              try {
                controller.close();
              } catch {
                /* 已关闭 */
              }
            });
            res.on("error", (err) => controller.error(err));
          },
          cancel() {
            res.destroy();
          },
        });
        const respHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") respHeaders.set(k, v);
        }
        // SSE 与二进制（视频）都按流透传，禁止缓冲
        respHeaders.delete("content-length");
        respHeaders.set("x-accel-buffering", "no");
        resolve(new Response(stream, { status: res.statusCode ?? 502, headers: respHeaders }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
