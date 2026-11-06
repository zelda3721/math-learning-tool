/**
 * 手搓最小单页 PDF（Helvetica 文本层；text 为空则无文本层）。
 *
 * 测试不该依赖仓库里的大 PDF：几行代码就能造出"有文本层/无文本层"两种情形，
 * 而且不随那本书换版本而失效。
 */
export function miniPdf(text: string): string {
  const stream = text ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET` : "";
  const objs = [
    "",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`,
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = pdf.length;
    pdf += objs[i] + "\n";
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

/** 直接把 miniPdf 变成 base64（PDF 里只有 ASCII，btoa 就够） */
export function miniPdfBase64(text: string): string {
  return Buffer.from(miniPdf(text), "latin1").toString("base64");
}
