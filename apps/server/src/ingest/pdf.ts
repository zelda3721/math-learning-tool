import { reconstructLines } from "@mathtutor/knowledge";

/**
 * PDF 文本层抽取，**按页返回**。
 *
 * 为什么单独一个文件而不是留在上传路由里：教材编译、题目上传两条路都要用它，
 * 而"按页"这个信息是教材那条路的命根子——切章靠的就是页码可回溯。
 * 之前只在路由里拼成一个字符串，等于把页码丢在了半路上。
 */

export interface PdfPage {
  /** 1 起，与 PDF 阅读器里的页序一致 */
  page: number;
  text: string;
}

/** 只留真正带文字的项（pdfjs 的 items 里还混着标记结构项，没有 str/transform） */
function textItemsOf(items: readonly unknown[]): { str: string; transform: number[] }[] {
  return items.flatMap((item) => {
    const it = item as { str?: unknown; transform?: unknown };
    return typeof it.str === "string" && Array.isArray(it.transform)
      ? [{ str: it.str, transform: it.transform as number[] }]
      : [];
  });
}

/**
 * 抽取每一页的文本层（pdfjs-dist 动态 import，避免拖慢启动）。
 *
 * 扫描版（没有文本层）返回的页文本是空串，由调用方决定怎么说这件事——
 * 在这里当成"没有文字"悄悄跳过，等于让家长上传一本扫描书之后看到一份空白章节表。
 */
export async function extractPdfPages(base64: string): Promise<PdfPage[]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(Buffer.from(base64, "base64"));
  const task = getDocument({ data, disableFontFace: true, useSystemFonts: true });
  try {
    const doc = await task.promise;
    const pages: PdfPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // 按视觉行重建，而不是把整页拼成一行——拼成一行会让标题消失在正文里，
      // 下游的切章规则会全部失效（实测一本 294 页的书因此被判成「整本一章」）
      pages.push({ page: i, text: reconstructLines(textItemsOf(tc.items)).join("\n") });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** 丢掉空页：没有文本层的页对切章没有任何信息，留着只会凭空切出一堆空章节 */
export function nonEmptyPages(pages: readonly PdfPage[]): PdfPage[] {
  return pages.filter((p) => p.text.trim().length > 0);
}
