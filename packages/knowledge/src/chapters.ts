/**
 * 教材章节切分：把一叠 PDF 页文本切成章。
 *
 * 顺序刻意是「书签 → 启发式 → 模型」三步降级里**能纯逻辑做的中间一步**：
 * 书签在别处（PDF 大纲）已经拿到，模型那步要花钱且不稳。启发式排在中间的理由是——
 * 绝大多数教材的章标题有固定样式，而那些样式恰恰是最容易用规则认出来的东西；
 * 认不出来时**保持"整本一章"**，而不是硬切出十几个碎片。
 *
 * 碎片比不切更糟：家长要核对一长串错误章节，比只核对一章更费神，
 * 而错误的切分会连带对齐出错误的候选节点。
 */

export interface PageText {
  /** 1 起的页码，只用于回溯与展示 */
  page: number;
  text: string;
}

export interface Chapter {
  title: string;
  /** 起止页码（含），便于家长翻回原书核对 */
  fromPage: number;
  toPage: number;
  text: string;
}

/** 认得的章标题样式。**只认行首、限定长度**：正文里提到"第三章"不该另起一章 */
const HEADING_PATTERNS: { name: string; re: RegExp }[] = [
  // 第X章 / 第X单元 / 第X节（中文数字或阿拉伯数字）
  { name: "numbered", re: /^\s*第\s*[0-9一二三四五六七八九十百]+\s*[章单元节讲]\s*[：:.、\s]?\s*\S.{0,30}$/ },
  // 1.2.3 标题 / 1 标题（纯数字编号开头，冒号或空格分隔）
  { name: "dotted", re: /^\s*\d+(?:\.\d+){0,3}[.、]?\s+\S.{0,30}$/ },
  // 一、二、三、标题
  { name: "chinese", re: /^\s*[一二三四五六七八九十]+\s*[、.．]\s*\S.{0,30}$/ },
];

/** 标题行的长度上限：更长的多半是正文里的一句话，不是标题 */
const MAX_HEADING_CHARS = 40;

export function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HEADING_CHARS) return false;
  // 以句号/分号结尾的通常是一句话，不是标题
  if (/[。；;]$/.test(trimmed)) return false;
  return HEADING_PATTERNS.some((p) => p.re.test(trimmed));
}

/**
 * 切章。
 *
 * 无标题时返回**整本一章**（标题用 fallbackTitle），而不是按页切——
 * 按页切出来的"第 1 页、第 2 页……"对家长毫无意义，还会把一节内容拆散到两章。
 */
export function splitChapters(pages: readonly PageText[], fallbackTitle = "全书"): Chapter[] {
  if (pages.length === 0) return [];

  const chapters: Chapter[] = [];
  let current: { title: string; fromPage: number; lines: string[] } | null = null;

  for (const page of pages) {
    for (const rawLine of page.text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (looksLikeHeading(line)) {
        if (current) {
          chapters.push({
            title: current.title,
            fromPage: current.fromPage,
            toPage: page.page,
            text: current.lines.join("\n"),
          });
        }
        current = { title: line, fromPage: page.page, lines: [] };
        continue;
      }
      if (!current) current = { title: fallbackTitle, fromPage: page.page, lines: [] };
      current.lines.push(line);
    }
  }

  if (current) {
    chapters.push({
      title: current.title,
      fromPage: current.fromPage,
      toPage: pages[pages.length - 1]!.page,
      text: current.lines.join("\n"),
    });
  }

  return chapters;
}
