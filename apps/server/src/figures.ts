/**
 * 题目原图的存取。
 *
 * 为什么原图是主表示、而不是模型转写的「点线角 + 约束」：
 * 原图就是原图，不存在重新理解的风险。规格再工整也是二手的——
 * 实机上见过它把直角梯形画成上下颠倒，见过它对着数图形的网格给出 52 个点。
 * 孩子做题时看的必须是讲义上那张图。
 *
 * 规格仍然有它不可替代的用处（讲解时高亮某条边、割补、变式跟着数字变），
 * 但那是**按需转写的增强**，等到真要做动画时再从原图转，转完还要与原图核对。
 *
 * 文件放在 config.figuresDir（默认 /media/figures），刻意在 data/ 之外：
 * 这些是二进制，一份讲义几十张，进 git 会让仓库越滚越大，而它们随时能重新导。
 * 换机器时手工拷贝这个目录即可。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

/** data URL 里允许的图片类型与它们的扩展名 */
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** 单张图的上限：一道题的配图裁出来通常几十 KB，超出 4MB 一定是哪里错了 */
const MAX_BYTES = 4 * 1024 * 1024;

export interface StoredFigure {
  name: string;
  bytes: number;
}

/**
 * 文件名只允许我们自己生成的那种形状。
 * 服务端凭文件名读盘，放宽一点就是任人读走整个磁盘。
 */
export function isSafeFigureName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}\.(jpg|png|webp)$/i.test(name);
}

/**
 * 存一张原图，返回文件名。
 *
 * 名字用内容哈希：同一张图（同一道题被重复导入）不会在磁盘上堆出好几份，
 * 而不同的图必然是不同的名字。
 */
export function storeFigure(dir: string, dataUrl: string): StoredFigure {
  const m = /^data:(image\/[\w.+-]+);base64,/.exec(dataUrl);
  if (!m) throw new Error("配图必须是 data:image/...;base64 形式");
  const ext = EXT[m[1]!.toLowerCase()];
  if (!ext) throw new Error(`不支持的图片类型：${m[1]}`);
  const buf = Buffer.from(dataUrl.slice(m[0].length), "base64");
  if (buf.length === 0) throw new Error("配图是空的");
  if (buf.length > MAX_BYTES) {
    throw new Error(`配图 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 4MB 上限`);
  }
  mkdirSync(dir, { recursive: true });
  const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 32)}.${ext}`;
  const file = path.join(dir, name);
  // 内容哈希相同就是同一张图，重复导入时不必再写一遍
  if (!existsSync(file)) writeFileSync(file, buf);
  return { name, bytes: buf.length };
}

export interface LoadedFigure {
  body: Buffer;
  contentType: string;
}

/** 按文件名读一张原图；名字不合规或文件不在都返回 null（调用方给 404） */
export function loadFigure(dir: string, name: string): LoadedFigure | null {
  if (!isSafeFigureName(name)) return null;
  const file = path.join(dir, name);
  // 名字已经过白名单，这里再确认解析结果没跑出目录——两道锁比一道稳
  if (path.dirname(path.resolve(file)) !== path.resolve(dir)) return null;
  if (!existsSync(file)) return null;
  const ext = path.extname(name).slice(1).toLowerCase();
  return {
    body: readFileSync(file),
    contentType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg",
  };
}

/**
 * 删掉没有任何题目再引用的图。
 *
 * 撤回一个批次时磁盘上会留下一堆孤儿；不清理的话，
 * media/figures 只增不减，几个月后没人说得清哪张还有用。
 */
export function pruneFigures(dir: string, referenced: Set<string>): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!isSafeFigureName(name) || referenced.has(name)) continue;
    try {
      unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      /* 删不掉就留着，不值得为清理失败中断请求 */
    }
  }
  return removed;
}
