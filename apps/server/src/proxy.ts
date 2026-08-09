import type { Context } from "hono";

/**
 * 引擎反向代理：透传请求体与 SSE 流。
 * 学生设备只连 server；server 是引擎的唯一调用方（注入 learner_id 的位置）。
 */
export async function proxyToEngine(c: Context, engineUrl: string): Promise<Response> {
  const url = new URL(c.req.url);
  const target = engineUrl + url.pathname + url.search;

  const headers = new Headers();
  const contentType = c.req.header("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = c.req.header("accept");
  if (accept) headers.set("accept", accept);

  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  const upstream = await fetch(target, {
    method,
    headers,
    body: hasBody ? c.req.raw.body : undefined,
    // Node fetch 需要显式声明流式 body
    ...(hasBody ? { duplex: "half" as const } : {}),
  });

  // SSE 与二进制（视频）都按流透传，禁止缓冲
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("content-length");
  respHeaders.set("x-accel-buffering", "no");
  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}
