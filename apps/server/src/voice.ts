import type { AppState } from "./app.js";

/**
 * 语音服务的网关侧入口（ASR / TTS 都在 compute-worker 里）。
 *
 * 抽出来放这里，而不是各模块自己写一份 fetch：口语对练和听力都要合成语音，
 * 两处各写一遍，超时、错误话术、base64 处理迟早会对不上。
 */

export async function engineJson(state: AppState, pathname: string, body: unknown, timeoutMs: number): Promise<Response> {
  const fetchImpl = state.engineFetch ?? fetch;
  return fetchImpl(`${state.config.engineUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 合成一段话；返回 base64 wav 与耗时。失败返回 null——文字照给，不让孩子面对错误码 */
export async function synthesizeSpeech(
  state: AppState,
  text: string,
  opts: { voice?: string; speed?: number } = {},
): Promise<{ base64: string; ms: number } | null> {
  const started = Date.now();
  try {
    const res = await engineJson(state, "/api/v1/tts", { text, ...opts }, 30_000);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    return { base64: buf.toString("base64"), ms: Date.now() - started };
  } catch {
    return null;
  }
}

/**
 * 把多段 wav 接成一段。
 *
 * 为什么要接：TTS 接口单次只收 500 字，而一段听力材料往往更长。直接拼字节不行——
 * 每个 wav 都带自己的 44 字节头，拼起来播放器只认第一段。
 * 这里按 RIFF 结构取出各自的 data 块，重写一个头（格式要求上游一致：
 * mono / 16bit / 同采样率，`say` 的输出满足）。
 */
export function concatWav(chunks: Buffer[]): Buffer {
  const parsed = chunks.map((buf) => parseWav(buf)).filter((p): p is ParsedWav => p !== null);
  if (parsed.length === 0) return Buffer.alloc(0);
  if (parsed.length === 1) return chunks[0]!;
  const first = parsed[0]!;
  const data = Buffer.concat(parsed.map((p) => p.data));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(first.channels, 22);
  header.writeUInt32LE(first.sampleRate, 24);
  header.writeUInt32LE(first.sampleRate * first.channels * (first.bitsPerSample / 8), 28);
  header.writeUInt16LE(first.channels * (first.bitsPerSample / 8), 32);
  header.writeUInt16LE(first.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

interface ParsedWav {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
}

function parseWav(buf: Buffer): ParsedWav | null {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let channels = 1;
  let sampleRate = 22050;
  let bitsPerSample = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    }
    if (id === "data") {
      return { channels, sampleRate, bitsPerSample, data: buf.subarray(body, Math.min(body + size, buf.length)) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** 把长文本切成 ≤limit 的片段，尽量落在句号/问号处（一句话被切开，语调会很怪） */
export function splitForSpeech(text: string, limit = 450): string[] {
  const clean = text.trim();
  if (clean.length <= limit) return clean ? [clean] : [];
  const sentences = clean.split(/(?<=[.?!])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && current.length + s.length + 1 > limit) {
      chunks.push(current);
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** 长文本合成：分段合成再拼起来；任意一段失败就整体失败（半段音频比没有更糟） */
export async function synthesizeLongSpeech(
  state: AppState,
  text: string,
  opts: { voice?: string; speed?: number } = {},
): Promise<{ base64: string; ms: number } | null> {
  const started = Date.now();
  const parts = splitForSpeech(text);
  if (parts.length === 0) return null;
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const res = await synthesizeSpeech(state, part, opts);
    if (!res) return null;
    buffers.push(Buffer.from(res.base64, "base64"));
  }
  return { base64: concatWav(buffers).toString("base64"), ms: Date.now() - started };
}
