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

/**
 * worker 由我们自己托管在 public/ 下（scripts/sync-pdf-worker.mjs 在 dev/build 前同步）。
 *
 * 曾用 `import("pdfjs-dist/build/pdf.worker.mjs?url")` 拿 URL，实测会在运行时
 * 抛 "Invalid workerSrc type"——那种写法依赖打包器把查询串翻译成 URL，
 * 一旦打包路径不同就拿到非字符串，而且要等到用户上传时才暴露。
 * public/ 下的路径在 dev 与 build 下完全一致，没有中间层可以出错。
 */
const WORKER_URL = "/pdfjs/pdf.worker.min.mjs";

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  if (typeof pdfjs.GlobalWorkerOptions.workerSrc !== "string" || !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;
  }
  return pdfjs;
}

/**
 * 打开一次文档：体检与渲染都在这一趟里做完。
 *
 * pdf.js 会把传进去的 ArrayBuffer **转移**给 worker 线程（detach），
 * 同一个 buffer 再用第二次就会抛 "Cannot perform Construct on a detached ArrayBuffer"。
 * 所以既不能开两次文档，也要把数据先复制一份再交出去——
 * 调用方手里那份还得留着（比如失败后改走图片上传）。
 */
export interface PdfPagesResult {
  verdict: TextLayerVerdict;
  pages: PdfPageImage[];
}

/**
 * 交给 pdf.js 的数据必须是副本。
 *
 * pdf.js 会把传入的缓冲区**转移**给 worker，之后调用方手里那份就成了空壳，
 * 再碰就是 `Cannot perform Construct on a detached ArrayBuffer`。
 * 调用方通常还要留着原始数据（失败后改走图片上传、或重试），所以一律先复制。
 */
export function toPdfData(file: ArrayBuffer): Uint8Array {
  return new Uint8Array(file.slice(0));
}

export async function pdfToPages(
  file: ArrayBuffer,
  options: RenderOptions = {},
): Promise<PdfPagesResult> {
  const targetWidth = options.targetWidth ?? 1600;
  const quality = options.quality ?? 0.82;
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: toPdfData(file) }).promise;
  const out: PdfPageImage[] = [];
  let digits = 0;
  let drawings = 0;
  const sampled = Math.min(doc.numPages, 4);

  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (options.signal?.aborted) break;
      const page = await doc.getPage(n);
      // 顺手体检前几页的文本层：数字寥寥而图形密布，说明数量是画上去的
      if (n <= sampled) {
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
      }
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
  return {
    verdict: judgeTextLayer(digits / Math.max(1, sampled), drawings / Math.max(1, sampled)),
    pages: out,
  };
}

/**
 * 文本层是否可信。不可信就该整页走视觉，而不是把带窟窿的题干送进抽取——
 * 那样得到的题看起来完整、数量却是空的，比抽不出来更坏。
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

