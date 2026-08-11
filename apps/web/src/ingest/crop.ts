/**
 * 按版面给的框把页图裁成单题图。
 *
 * 能这么做，是因为渲染本来就发生在浏览器里——canvas 现成的。
 * 裁剪的意义不只是省 token：一张只含一道题的图，模型不用先在满页里
 * 找边界再读内容，小字和图形标注的识别率会明显好于整页。
 *
 * 但裁错比不裁更糟：裁走半道题，后面每个字段都是错的，而且从结果上看不出来。
 * 所以框的校验（normalizeBox）宁严勿宽，拿不准就退回整页——
 * 整页只是效果差一点，裁错是无声的错。
 */

/** 版面框：[左, 上, 右, 下]，均为 0~1 的相对比例 */
export type Box = [number, number, number, number];

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 相对框 → 像素矩形，四周留一点余量。
 *
 * 留余量是因为模型给的框普遍偏紧，正好卡在字的边缘上：
 * 差几个像素就会把「12」裁成「2」，而那正是这道题的答案。
 * 上下比左右多留一些——题号和末行最常被切到。
 */
export function cropRect(
  box: Box,
  imageWidth: number,
  imageHeight: number,
  padX = 0.015,
  padY = 0.02,
): CropRect {
  const [x0, y0, x1, y1] = box;
  const left = Math.max(0, x0 - padX);
  const top = Math.max(0, y0 - padY);
  const right = Math.min(1, x1 + padX);
  const bottom = Math.min(1, y1 + padY);
  const x = Math.round(left * imageWidth);
  const y = Math.round(top * imageHeight);
  return {
    x,
    y,
    // 至少 1px：宽高为 0 时 canvas 会抛错，而这里本该是"框没用"的问题
    width: Math.max(1, Math.round(right * imageWidth) - x),
    height: Math.max(1, Math.round(bottom * imageHeight) - y),
  };
}

/**
 * 裁出来的图太小就没有裁的意义——放大送过去只会更糊。
 * 单题在一张 1600px 宽的页图上通常有 200px 以上的高度。
 */
export function worthCropping(rect: CropRect): boolean {
  return rect.width >= 200 && rect.height >= 60;
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("页图解码失败"));
    img.src = dataUrl;
  });
}

/**
 * 把页图裁成单题图。框不可用或裁出来太小时返回 null，
 * 调用方据此退回整页——**绝不返回一张裁坏的图**。
 */
export async function cropPage(
  pageDataUrl: string,
  box: Box | undefined,
  quality = 0.85,
): Promise<string | null> {
  if (!box) return null;
  const img = await loadImage(pageDataUrl);
  const rect = cropRect(box, img.naturalWidth, img.naturalHeight);
  if (!worthCropping(rect)) return null;

  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // 讲义是黑字白底；不铺白底，透明处在 JPEG 里会变黑
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const out = canvas.toDataURL("image/jpeg", quality);
  canvas.width = 0;
  canvas.height = 0;
  return out;
}
