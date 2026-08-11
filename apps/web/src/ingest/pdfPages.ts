/**
 * PDF → 每页一张图（在浏览器里渲染）。
 *
 * 为什么不在服务端抽文本：拿真实讲义量过一遍，文本层里**没有数字**。
 * 「一块木板上有 ⟨空⟩ 枚钉子」不是解析 bug——那一页只有 6 个阿拉伯字符，
 * 却有 4 张位图和 143 条矢量路径：数字和图形都是画上去的，不在文本层。
 * 修行结构、修跨页都救不了，因为要的那个数根本不在里面。
 *
 * 所以整页渲染成图、走视觉抽取：数字、图形、表格一个不丢，
 * 顺带把「几何题要配图」这件事也解决了——图就在那张页图里，模型看得见。
 *
 * 放在浏览器做，是因为这里天生有 canvas。服务端要么装原生依赖（cairo），
 * 要么多一个 Python 服务，都比这重；而材料本来就是从浏览器上传的。
 */

export interface PdfPageImage {
  /** 从 1 开始 */
  page: number;
  /** data URL，直接喂给既有的图片抽取端点 */
  dataUrl: string;
}

export interface RenderOptions {
  /**
   * 目标宽度（像素）。视觉模型看清中文小字和图形标注大约需要 1500+；
   * 再高只是徒增体积与耗时。
   */
  targetWidth?: number;
  /** JPEG 质量：讲义以线条和文字为主，0.82 已经足够清晰 */
  quality?: number;
  /** 每渲染完一页回调一次，用来显示进度（整本书渲染要花几十秒） */
  onProgress?: (done: number, total: number) => void;
  /** 取消信号：用户切走或换文件时别继续烧 CPU */
  signal?: AbortSignal;
}

/** pdf.js 的 worker 与主线程版本必须一致，用同一份依赖解析可避免版本漂移 */
async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
  return pdfjs;
}

export async function pdfToPageImages(
  file: ArrayBuffer,
  options: RenderOptions = {},
): Promise<PdfPageImage[]> {
  const targetWidth = options.targetWidth ?? 1600;
  const quality = options.quality ?? 0.82;
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(file) }).promise;
  const out: PdfPageImage[] = [];

  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (options.signal?.aborted) break;
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      // 按目标宽度等比放大：讲义页宽差别很大，固定 scale 会让有的页糊、有的页巨大
      const viewport = page.getViewport({ scale: targetWidth / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器不支持 canvas，无法渲染 PDF");
      // 讲义多是黑字白底；不铺白底的话透明区域在 JPEG 里会变黑
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      out.push({ page: n, dataUrl: canvas.toDataURL("image/jpeg", quality) });
      // 及时释放：一本几十页的讲义，画布不放会把内存吃光
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      options.onProgress?.(n, doc.numPages);
    }
  } finally {
    await doc.cleanup();
  }
  return out;
}

/**
 * 判断 PDF 的文本层是否可信。
 *
 * 不可信就该整页走视觉，而不是把带窟窿的题干送进抽取——
 * 那样得到的题看起来完整，数量却是空的，比抽不出来更坏。
 */
export interface TextLayerVerdict {
  trustworthy: boolean;
  reason: string;
  digitsPerPage: number;
  drawingsPerPage: number;
}

/**
 * 判据（纯函数，可单测）：数学讲义每页总该有几个数；
 * 数字寥寥而图形密布，说明数量是被画上去的，不在文本层里。
 * 阈值取自真实材料：某讲义每页约 6 个数字、约 120 处图形。
 */
export function judgeTextLayer(digitsPerPage: number, drawingsPerPage: number): TextLayerVerdict {
  if (digitsPerPage < 12 && drawingsPerPage > 20) {
    return {
      trustworthy: false,
      reason: `文本层每页只有约 ${digitsPerPage.toFixed(0)} 个数字，却有约 ${drawingsPerPage.toFixed(0)} 处图形——数量多半是画上去的，抽出来会缺数`,
      digitsPerPage,
      drawingsPerPage,
    };
  }
  return { trustworthy: true, reason: "文本层可用", digitsPerPage, drawingsPerPage };
}

export async function inspectTextLayer(file: ArrayBuffer): Promise<TextLayerVerdict> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(file) }).promise;
  try {
    const pages = Math.min(doc.numPages, 4); // 抽样前几页足够判断
    let digits = 0;
    let drawings = 0;
    for (let n = 1; n <= pages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? (item as { str: string }).str : ""))
        .join("");
      digits += (text.match(/[0-9０-９]/g) ?? []).length;
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) {
        if (
          fn === pdfjs.OPS.paintImageXObject ||
          fn === pdfjs.OPS.paintInlineImageXObject ||
          fn === pdfjs.OPS.constructPath
        ) {
          drawings += 1;
        }
      }
      page.cleanup();
    }
    return judgeTextLayer(digits / pages, drawings / pages);
  } finally {
    await doc.cleanup();
  }
}
