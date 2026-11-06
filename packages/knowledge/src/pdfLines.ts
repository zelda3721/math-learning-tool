/**
 * PDF 文本项 → 视觉行。
 *
 * 为什么要单独做这一步：pdfjs 给出的是一堆文本片段（每段带自己的坐标与字号），
 * 直接把 `str` 用空格连起来，整页就成了一行——标题消失在正文中间，
 * 切章的所有规则随之失效（实测：一本 294 页的书因此被判成「整本一章」）。
 *
 * 也不能简单地按 y 四舍五入分组：标题的字号比正文大、基线 y 差几个单位，
 * 「Unit」「1」「am/is/are」就会被拆成三行。所以按邻近聚合，而不是按精确相等。
 */

export interface PdfTextItem {
  str: string;
  /** pdfjs 的 transform：[a,b,c,d,e,f]，e = x，f = 基线 y（PDF 坐标系向上为正） */
  transform: number[];
}

/** 同一行的 y 容差：按基线邻近判断，比按字号估算更稳（一本书里字号有好几种） */
const LINE_TOLERANCE = 4;

export function reconstructLines(items: readonly PdfTextItem[]): string[] {
  const usable = items
    .filter((it) => typeof it.str === "string" && it.str.trim() && Array.isArray(it.transform))
    .map((it) => ({ str: it.str, x: it.transform[4] ?? 0, y: it.transform[5] ?? 0 }));

  // PDF 的 y 向上为正：先按 y 降序（从上到下），同一行内再按 x 升序
  usable.sort((a, b) => (Math.abs(a.y - b.y) > LINE_TOLERANCE ? b.y - a.y : a.x - b.x));

  const lines: { y: number; parts: { x: number; str: string }[] }[] = [];
  for (const item of usable) {
    // 与上一条的基线相连即视为同一行
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.y) <= LINE_TOLERANCE) {
      last.parts.push({ x: item.x, str: item.str });
    } else {
      lines.push({ y: item.y, parts: [{ x: item.x, str: item.str }] });
    }
  }

  return lines
    .map((line) => {
      const parts = line.parts.sort((a, b) => a.x - b.x);
      let text = "";
      for (const part of parts) {
        // 中文片段之间不该塞空格：那会让「分数的意义」变成「分数的 意义」
        const glue = !text || (/[一-龥]$/.test(text) && /^[一-龥]/.test(part.str)) ? "" : " ";
        text += glue + part.str;
      }
      return text.replace(/\s+/g, " ").trim();
    })
    .filter(Boolean);
}
