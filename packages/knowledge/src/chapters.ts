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
  /**
   * 附录类内容（答案册、索引、词汇表）。
   *
   * 它们不是教学单元：实测那本语法书从「Key to Exercises」（p274 起）往后，
   * 每行都带题号 `95.4 was bad.`，按标题切会切出几十个假章节。
   * 这里保留内容但打上标记，下游抽取知识点时跳过——而不是悄悄丢掉。
   */
  backMatter?: boolean;
}

/** 附录的开头：答案册/索引/词汇表（实测的书里是「Key to Exercises」，字距导致「t o」中间有空格） */
const BACK_MATTER_RE = /^(?:keyto|answerto|answerkey|answers|index|glossary|appendix|参考答案|答案|附录|索引|词汇表)/i;

/** 附录从哪一页开始：取该页第一条非空行，去掉字距造成的空格再判断 */
function backMatterStart(pages: readonly PageText[]): number {
  for (let i = 0; i < pages.length; i++) {
    const firstLine = pages[i]!.text.split(/\r?\n/).find((l) => l.trim());
    if (firstLine && BACK_MATTER_RE.test(firstLine.replace(/\s+/g, ""))) return i;
  }
  return -1;
}

/** 认得的章标题样式。**只认行首、限定长度**：正文里提到"第三章"不该另起一章 */
const HEADING_PATTERNS: { name: string; re: RegExp; ok?: (line: string) => boolean }[] = [
  // 第X章 / 第X单元 / 第X节（中文数字或阿拉伯数字）
  { name: "numbered-cn", re: /^\s*第\s*[0-9一二三四五六七八九十百]+\s*[章单元节讲]\s*[：:.、\s]?\s*\S.{0,30}$/ },
  // 1.2.3 标题（多级编号）、1、标题（中文顿号）、一、标题。
  // **不认「1 空格 文字」**：实测一本真实练习册，练习题的行全是「1 she is」「2 I'm not hungry」，
  // 松一档就把练习册切成了 96 个"章节"。裸数字编号太常见，不能单独作标题凭据。
  // 光按编号认还不够——行重建修好之后，练习题的答案行也带着编号（「3.30 4.00 4.15」「1.1 2.1」），
  // 所以再要求编号后面真的跟着文字（见 isNumberedHeading）。
  {
    name: "numbered",
    re: /^\s*(?:\d+(?:\.\d+)+[.、]?|\d+[、．]|[一二三四五六七八九十]+[、.．])\s*\S.{0,40}$/,
    ok: isNumberedHeading,
  },
  // 英文教材的单元标题：Unit 1 am/is/are、Chapter 3 Fractions、Lesson 12
  // 实测驱动：拿一本真实的英语语法书跑，原样式把整本书切成了一章
  { name: "english", re: /^\s*(?:unit|chapter|lesson|part|section)\s+\d+\b.{0,40}$/i },
  // 单元标题被版式拆成好几行时，第一行只有一个光秃秃的 Unit/Chapter（实测：294 页的语法书
  // 「Unit」「1」「am/is/are」三行才凑成一个标题），标题的其余部分由 absorbHeadingFragments 补回
  { name: "structural", re: /^\s*(?:unit|chapter|lesson|part|section)\s*$/i },
];

/** 标题行的长度上限：更长的多半是正文里的一句话，不是标题 */
const MAX_HEADING_CHARS = 40;

/**
 * 编号后面必须跟着文字才算标题。
 *
 * 反例全是真实练习册里的行：`3.30 4.00 4.15`（答案是时间）、`1.1 2.1`（题号列）、
 * `5.5 UN IT 8`（页眉串行）。它们的共同点是——编号之后只剩数字或碎片。
 */
function isNumberedHeading(line: string): boolean {
  const rest = line.replace(/^\s*(?:\d+(?:\.\d+)+[.、]?|\d+[、．]|[一二三四五六七八九十]+[、.．])/, "");
  if (!/[\p{L}]{2,}/u.test(rest)) return false;
  // 编号之后又冒出孤立数字，基本就是题号/答案串
  if (/(?:^|\s)\d[\d.]*(?:\s|$)/.test(rest)) return false;
  return true;
}

export function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HEADING_CHARS) return false;
  // 以句号/分号结尾的通常是一句话，不是标题
  if (/[。；;]$/.test(trimmed)) return false;
  return HEADING_PATTERNS.some((p) => p.re.test(trimmed) && (p.ok ? p.ok(trimmed) : true));
}

/** 跨行的标题片段：短、不像一句话、不像 A/B/C 小节标签 */
function isHeadingFragment(line: string): boolean {
  if (line.length > MAX_HEADING_CHARS) return false;
  if (/[：:。；;]$/.test(line)) return false;
  if (/^[A-H](?:\s|$)/.test(line)) return false;
  return true;
}

/**
 * 一页上最多能容忍几个"标题"。
 *
 * 反例同样来自这本真实的语法书：**答案页**上每一行都以 `95.4 was bad.` 这样的题号开头，
 * 一页能认出几十个"标题"，把书尾切成了 30 多个假章节；**目录页**也一模一样。
 * 真正的章标题在版式上很稀疏（一页一个），所以超过这个数的一页，标题一律降级为正文。
 */
const MAX_HEADINGS_PER_PAGE = 4;

/**
 * 切章。
 *
 * 无标题时返回**整本一章**（标题用 fallbackTitle），而不是按页切——
 * 按页切出来的"第 1 页、第 2 页……"对家长毫无意义，还会把一节内容拆散到两章。
 */
export function splitChapters(pages: readonly PageText[], fallbackTitle = "全书"): Chapter[] {
  if (pages.length === 0) return [];

  // 附录（答案册/索引）不进正文切章：它的每行都像题号，切出来全是假章节
  const backAt = backMatterStart(pages);
  const bodyPages = backAt === -1 ? pages : pages.slice(0, backAt);
  const backPages = backAt === -1 ? [] : pages.slice(backAt);

  const chapters = splitBodyChapters(bodyPages, fallbackTitle);

  if (backPages.length > 0) {
    const firstLine = backPages[0]!.text.split(/\r?\n/).find((l) => l.trim()) ?? "附录";
    chapters.push({
      title: firstLine.trim(),
      fromPage: backPages[0]!.page,
      toPage: backPages[backPages.length - 1]!.page,
      text: backPages
        .flatMap((p) => p.text.split(/\r?\n/))
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n"),
      backMatter: true,
    });
  }

  return chapters;
}

function splitBodyChapters(pages: readonly PageText[], fallbackTitle: string): Chapter[] {
  if (pages.length === 0) return [];

  // 先按页统计标题：过密的一页（答案页、目录页）不算标题
  const densePages = new Set(
    pages
      .filter((page) => page.text.split(/\r?\n/).filter((l) => looksLikeHeading(l.trim())).length > MAX_HEADINGS_PER_PAGE)
      .map((page) => page.page),
  );

  const chapters: Chapter[] = [];
  let current: {
    title: string;
    /** 还能从后面吸收几个标题片段（版式把标题拆成多行时要） */
    fragmentsLeft: number;
    fromPage: number;
    /** 归到本章的**最后一页**：下一页的标题不代表上一章延伸到了那一页 */
    lastPage: number;
    lines: string[];
  } | null = null;

  for (const page of pages) {
    const headingsUsable = !densePages.has(page.page);
    for (const rawLine of page.text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (headingsUsable && looksLikeHeading(line)) {
        if (current) {
          chapters.push({
            title: current.title,
            fromPage: current.fromPage,
            toPage: current.lastPage,
            text: current.lines.join("\n"),
          });
        }
        // 光秃秃的 Unit/Chapter 之后通常还跟着单元号和标题，留给后面两行补
        const bare = /^(?:unit|chapter|lesson|part|section)$/i.test(line);
        current = { title: line, fragmentsLeft: bare ? 2 : 0, fromPage: page.page, lastPage: page.page, lines: [] };
        continue;
      }
      if (!current) {
        current = { title: fallbackTitle, fragmentsLeft: 0, fromPage: page.page, lastPage: page.page, lines: [] };
      }
      current.lastPage = page.page;

      if (current.fragmentsLeft > 0 && isHeadingFragment(line)) {
        current.fragmentsLeft--;
        current.title = joinTitleFragment(current.title, line);
        continue;
      }
      current.fragmentsLeft = 0;
      current.lines.push(line);
    }
  }

  if (current) {
    chapters.push({
      title: current.title,
      fromPage: current.fromPage,
      toPage: current.lastPage,
      text: current.lines.join("\n"),
    });
  }

  return chapters;
}

/** 把片段并进标题：单元号紧跟结构词（「Unit」+「46」→「Unit 46」），其余按出现顺序追加 */
function joinTitleFragment(title: string, fragment: string): string {
  if (/^\d+$/.test(fragment)) {
    const parts = title.split(/\s+/);
    return [parts[0], fragment, ...parts.slice(1)].join(" ");
  }
  return `${title} ${fragment}`;
}
