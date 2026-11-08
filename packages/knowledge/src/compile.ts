import type { Chapter } from "./chapters.js";

/**
 * 教材知识编译：把「一章一章的正文」编译成「以概念为单位的中间产物」。
 *
 * 和 [extract.ts](./extract.ts) 那版抽取的区别，不是"多抽了几个字段"，而是**对象变了**：
 * 那版每章各抽一批草稿，草稿之间互不相干，一个概念在两章出现就是两条；
 * 这里概念本身是编译单元——同名概念跨章合并、去重、冲突留痕，每条都带页码出处。
 *
 * 为什么这件事值得单独做一层：
 *
 * 1. **教材五花八门，概念不是**。书的组织方式（单元/章/节/练习页）差异巨大，
 *    但"通分"就是"通分"。把差异留在书这一侧（chapters），把共性提炼到概念这一侧，
 *    下游的对齐与排课才有一个稳定的对象可用。
 * 2. **可以重编译**。概念 id 由规范名派生，所以同一本书重跑一次，
 *    新增/消失/改动的概念能逐条列出来——调提示词时，这是唯一有效的反馈。
 *    如果 id 由模型每次现编，两版产物根本没法比。
 * 3. **冲突不自动选边**。同一个概念两处定义矛盾时，两边都留着并标出来，
 *    由家长或后续人工决定。这与本项目一贯的门禁思路一致：宁可如实标出，也不猜。
 *
 * 这里全部是纯逻辑（无 IO、无网络），模型只通过 provider 端口进来；
 * 落盘在 [compiled.ts](./compiled.ts)，接线在 apps/server。
 */

export interface ConceptDraft {
  /** 概念名（尽量短，能对上图谱节点名） */
  title: string;
  /** 一句话定义 */
  definition: string;
  /** 要点 */
  keyPoints: string[];
  /** 先修概念名（书内自述的），用于生成书内先修边 */
  prerequisites: string[];
  /** 支撑这个概念的原文片段 */
  evidence: string;
}

export interface ConceptExtractionProvider {
  extract(input: { chapterTitle: string; text: string }): Promise<ConceptDraft[]>;
}

/**
 * 引文核对结果。
 *
 * 教学宪法第 5 条要求"归因必须有证据"，而证据得**真的在原文里**。
 * 模型很会写一段像原文的话；那段话一旦以"出处：> ……"的样子展示给家长，
 * 就比没有出处更糟——它把编造变成了引用。
 *
 * - `exact`      整段引文能在正文里定位到（忽略空白与标点差异）
 * - `partial`    只有一部分句子能定位到
 * - `not_found`  一句都定位不到：这段引文是模型改写的，不能当引文用
 */
export type QuoteVerification = "exact" | "partial" | "not_found";

export interface ConceptSource {
  chapterTitle: string;
  fromPage: number;
  toPage: number;
  /** 原文片段：家长核对与后续对齐都靠它 */
  quote: string;
  /** 这段引文是否真的出自这一章（见 QuoteVerification） */
  verification: QuoteVerification;
}

export interface ConceptConflict {
  chapterTitle: string;
  fromPage: number;
  /** 与本书内主定义不一致的那一条定义原文 */
  definition: string;
}

export interface CompiledConcept {
  /** 稳定 id：由规范名派生，重编译同一个概念得到同一个 id */
  id: string;
  title: string;
  definition: string;
  keyPoints: string[];
  prerequisites: string[];
  sources: ConceptSource[];
  /**
   * 是否至少有一处出处能在原文里定位到。
   *
   * false 意味着这个概念的全部"证据"都是模型改写的——按教学宪法，
   * 它不能承重：不参与对齐，也只作为线索展示。
   */
  verified: boolean;
  /** 只在真的矛盾时非空；主定义保留在 definition 里，冲突方在这里 */
  conflicts: ConceptConflict[];
}

export interface CompiledBook {
  title: string;
  concepts: CompiledConcept[];
  /** 书内先修边：from 是先修，to 是后继 */
  links: { from: string; to: string; kind: "prerequisite" }[];
  /** 书里提到、但这本书里没有单独成概念的先修（悬空，交给人看） */
  unresolvedPrerequisites: { conceptId: string; title: string }[];
  coverage: {
    chapters: number;
    chaptersWithConcepts: number;
    concepts: number;
    /** 其中至少有一处出处能定位到原文的（其余只作线索） */
    verifiedConcepts: number;
  };
  /** 有任何一章退回离线兜底就是 true */
  degraded: boolean;
}

/** 一章最多编译这么多个概念：再多基本是切碎了，反而没法对齐 */
const MAX_CONCEPTS_PER_CHAPTER = 12;

/** 一条概念至少要有这么多字原文，否则撑不起一次对齐（与 extract.ts 同一口径） */
const MIN_EVIDENCE_CHARS = 12;

const MAX_KEY_POINTS = 8;
const MAX_PREREQUISITES = 8;

/**
 * 规范名：概念身份的依据。
 *
 * 去掉大小写、空白与标点差异——「分数的意义」和「分数的意义 」、
 * 「am/is/are」和「am is are」是同一个概念。刻意**不**做同义词归并：
 * 那需要判断力，交给合并提案与人工，而不是藏在一个正则里。
 */
export function normalizeConceptName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[。．]/g, ".")
    .replace(/[（）()【】\[\]{}「」『』《》<>"'“”‘’.,，。、;；:：!！?？·—\-_/\\|~]+/g, "");
}

/**
 * 比对用的规范化：去掉空白、统一引号与破折号。
 *
 * 为什么要去空白：PDF 抽出来的文本带着字距造成的碎空格（实测「The」会变成「! e」），
 * 模型照抄时也常顺手把换行折成空格。这些差异不是"引错了"，不该判成未定位。
 * 但**不做同义改写/语序归一**——那样就等于放过模型自由发挥，而这正是要拦的东西。
 */
/**
 * 比对用的规范化：去掉空白、统一引号与破折号，并修掉一类 PDF 字形错配。
 *
 * 为什么要去空白：PDF 抽出来的文本带着字距造成的碎空格，模型照抄时也常顺手把
 * 换行折成空格。这些差异不是"引错了"，不该判成未定位。
 *
 * 为什么修 `!` → `th`：这本真实教材的嵌入字体把 "Th" 映射成了 "!"，
 * 抽出来是「! e present simple negative」。模型读的时候正确地把它当成 "The"，
 * 于是**忠实的引文反而判成未定位**（实机：25 条出处里有 6 条这么被冤枉）。
 * 修法与正文同侧：两边都做同样的替换，所以编造的引文不会因此蒙混过关——
 * 它得先恰好写成 "Th" 开头、正文里又恰好有对应的字形错配。
 *
 * **不做**同义改写、语序归一、相似度阈值：一放进去，"像原文"就能冒充"是原文"，
 * 而这正是要拦的东西。
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/!\s?(?=[a-z])/g, "th")
    .replace(/[\s　]+/g, "")
    // 中英文句号视作同一件事：PDF 抽取与模型转写经常来回换
    .replace(/[。．]/g, ".")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[—–−]/g, "-");
}

/** 引文里"够一句"的最小长度：再短的片段几乎必然能在任何正文里撞上，判定没有意义 */
const MIN_QUOTE_CHARS = 6;

/**
 * 核对一段引文是否真的出自这一章正文。
 *
 * 先整段比对；不行再按句拆开比对——模型经常把三句原文压成两句、只抄其中一句，
 * 或者用「…」把不相邻的几处拼起来。剩下能定位到的句子比例决定 exact/partial/not_found。
 */
export function verifyQuote(
  quote: string,
  chapterText: string,
): { verification: QuoteVerification; matchedSentences: number; totalSentences: number } {
  const normalizedQuote = normalizeForMatch(quote);
  const normalizedText = normalizeForMatch(chapterText);

  if (normalizedQuote.length < MIN_QUOTE_CHARS || !normalizedText) {
    return { verification: "not_found", matchedSentences: 0, totalSentences: 0 };
  }
  if (normalizedText.includes(normalizedQuote)) {
    return { verification: "exact", matchedSentences: 1, totalSentences: 1 };
  }

  const sentences = quote
    // 「…」也算句子边界：模型爱用它把不相邻的几处原文拼成一段
    .split(/[。！？!?;；\n]+|\.{3,}|…+/)
    .map((s) => normalizeForMatch(s))
    .filter((s) => s.length >= MIN_QUOTE_CHARS);
  if (sentences.length === 0) {
    return { verification: "not_found", matchedSentences: 0, totalSentences: 0 };
  }
  const matched = sentences.filter((s) => normalizedText.includes(s)).length;
  if (matched === 0) return { verification: "not_found", matchedSentences: 0, totalSentences: sentences.length };
  // 整段没能连续定位，就只能是 partial：即便每一句都找得到，
  // 这段引文也是把不相邻的几处拼起来的，展示时得说清楚。
  const verification: QuoteVerification = matched * 2 >= sentences.length ? "partial" : "not_found";
  return { verification, matchedSentences: matched, totalSentences: sentences.length };
}

/** 规范名 → 稳定 id（FNV-1a，8 位十六进制）。不依赖任何运行时，重编译结果一致 */
export function conceptIdOf(title: string): string {
  const normalized = normalizeConceptName(title);
  let hash = 0x811c9dc5;
  for (const ch of normalized) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}`;
}

/**
 * 离线兜底：把段落当概念桩。
 *
 * 同样刻意不做"关键词提取"那种聪明事：没有模型时能确定的是段落边界，
 * 而不是哪个词更重要。产物质量低一档，但结构、id、出处都是真的。
 */
export function compileChapterOffline(chapter: Chapter): ConceptDraft[] {
  const paragraphs = chapter.text
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= MIN_EVIDENCE_CHARS);

  const drafts: ConceptDraft[] = [];
  for (const para of paragraphs) {
    if (drafts.length >= MAX_CONCEPTS_PER_CHAPTER) break;
    const firstSentence = (para.split(/[。！？!?]/)[0] ?? para).trim() || para;
    drafts.push({
      title: firstSentence.slice(0, 16),
      definition: firstSentence.slice(0, 60),
      keyPoints: [],
      prerequisites: [],
      evidence: para.slice(0, 400),
    });
  }
  return drafts;
}

/** 清洗模型给的草稿：任何一项站不住就丢掉，而不是带着半截数据往下走 */
function sanitizeDrafts(raw: readonly ConceptDraft[]): ConceptDraft[] {
  const out: ConceptDraft[] = [];
  for (const draft of raw) {
    const title = typeof draft?.title === "string" ? draft.title.trim().slice(0, 40) : "";
    const evidence = typeof draft?.evidence === "string" ? draft.evidence.trim() : "";
    if (!title) continue;
    if (evidence.length < MIN_EVIDENCE_CHARS) continue;
    const definition = typeof draft.definition === "string" ? draft.definition.trim().slice(0, 240) : "";
    const keyPoints = Array.isArray(draft.keyPoints)
      ? draft.keyPoints
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.trim().slice(0, 120))
          .slice(0, MAX_KEY_POINTS)
      : [];
    const prerequisites = Array.isArray(draft.prerequisites)
      ? draft.prerequisites
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.trim().slice(0, 40))
          .slice(0, MAX_PREREQUISITES)
      : [];
    out.push({ title, definition: definition || evidence.slice(0, 60), keyPoints, prerequisites, evidence: evidence.slice(0, 400) });
    if (out.length >= MAX_CONCEPTS_PER_CHAPTER) break;
  }
  return out;
}

interface Accumulator {
  concept: CompiledConcept;
  /** 用于识别"同名但不同写法"的 id 冲突 */
  normalized: string;
  /** 合并时用来判断"定义是否真的不同" */
  definitionKeys: Set<string>;
}

function definitionKey(definition: string): string {
  return normalizeConceptName(definition);
}

/** 两条定义是不是在说同一件事：规范化后相同，或一方包含另一方 */
function definitionsAgree(a: string, b: string): boolean {
  const ka = definitionKey(a);
  const kb = definitionKey(b);
  if (!ka || !kb) return true;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

/**
 * 默认并发数。
 *
 * 本地常驻模型实测吞吐约 45 token/s（Qwen3.8-Flash-Next，oMLX）。这意味着
 * **并发给不了额外的吞吐**：总时间下限约等于总 token 数 ÷ 45。并发能省掉的是
 * 请求之间的空档（prefill 期间 GPU 原本空着），所以收益有限、且很快见顶。
 *
 * 同一批 6 章（16963 字）实测：并发 1 → 102.8s，2 → 97.0s，3 → 80.4s，
 * 4 的两次跑出 56.0s 与 115.8s（噪声压过了并发本身的影响，本地服务同时在干别的）。
 * 结论：2~3 路把管道填满就够；4 是上限，再往上只会让单请求延迟拉长、更容易撞超时。
 * 真要整本快起来，杠杆是**每章的输出预算**，不是并发数。
 */
export const DEFAULT_COMPILE_CONCURRENCY = 2;
export const MAX_COMPILE_CONCURRENCY = 4;

export function clampConcurrency(value: unknown, fallback = DEFAULT_COMPILE_CONCURRENCY): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_COMPILE_CONCURRENCY);
}

/** 有界并发 map：结果按输入顺序返回，让后续合并顺序与串行时完全一致 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * 编译一本书。
 *
 * 顺序：每章先问模型，失败/抽出空就退回离线兜底（如实标 degraded），
 * 然后按规范名合并跨章同名概念，最后把先修名解析成书内边。
 *
 * 并发只影响"什么时候拿到草稿"，不影响合并顺序：合并始终按章节顺序做，
 * 所以并发 1 和并发 3 编出来的产物逐字相同（有测试钉住）。
 */
export async function compileBook(
  chapters: readonly Chapter[],
  options: {
    title?: string;
    provider?: ConceptExtractionProvider | null;
    /** 同时在飞的模型请求数；默认 2，见 DEFAULT_COMPILE_CONCURRENCY 的理由 */
    concurrency?: number;
    /** 每章抽完的回调（进度用；长任务里家长能看见已经编到哪一章） */
    onChapterDone?: (done: number, total: number, chapterTitle: string) => void;
  } = {},
): Promise<CompiledBook> {
  const bodyChapters = chapters.filter((c) => !c.backMatter);
  let done = 0;

  const extracted = await mapWithConcurrency(
    bodyChapters,
    clampConcurrency(options.concurrency),
    async (chapter) => {
      let drafts: ConceptDraft[] = [];
      let fellBack = !options.provider;
      if (options.provider) {
        try {
          drafts = sanitizeDrafts(await options.provider.extract({ chapterTitle: chapter.title, text: chapter.text }));
        } catch {
          drafts = [];
        }
        // 模型不可用、或这一章什么都没抽出来：退回离线兜底，不让链停在这里
        if (drafts.length === 0) {
          drafts = compileChapterOffline(chapter);
          fellBack = true;
        }
      } else {
        drafts = compileChapterOffline(chapter);
      }
      // 核对每段引文是否真的出自这一章：模型编造的"原文"不许当出处用
      const verified = drafts.map((draft) => ({
        ...draft,
        verification: verifyQuote(draft.evidence, chapter.text).verification,
      }));
      done += 1;
      options.onChapterDone?.(done, bodyChapters.length, chapter.title);
      return { drafts: verified, fellBack };
    },
  );

  // 只要有一章用了兜底，整份产物就是降级的（如实标，不做四舍五入）
  const degraded = extracted.some((e) => e.fellBack);

  const byId = new Map<string, Accumulator>();
  const idOwner = new Map<string, string>();

  for (let index = 0; index < bodyChapters.length; index++) {
    const chapter = bodyChapters[index]!;
    const drafts = extracted[index]?.drafts ?? [];

    for (const draft of drafts) {
      const normalized = normalizeConceptName(draft.title);
      if (!normalized) continue;
      let id = conceptIdOf(draft.title);
      // 极少数哈希撞车：给个后缀，宁可 id 不好看，也不要两个概念共用一个 id
      if (idOwner.has(id) && idOwner.get(id) !== normalized) {
        let n = 2;
        while (idOwner.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      idOwner.set(id, normalized);

      const source: ConceptSource = {
        chapterTitle: chapter.title,
        fromPage: chapter.fromPage,
        toPage: chapter.toPage,
        quote: draft.evidence,
        verification: draft.verification,
      };

      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, {
          normalized,
          definitionKeys: new Set([definitionKey(draft.definition)]),
          concept: {
            id,
            title: draft.title,
            definition: draft.definition,
            keyPoints: [...draft.keyPoints],
            prerequisites: [...draft.prerequisites],
            sources: [source],
            verified: source.verification !== "not_found",
            conflicts: [],
          },
        });
        continue;
      }

      const concept = existing.concept;
      if (!definitionsAgree(concept.definition, draft.definition)) {
        concept.conflicts.push({
          chapterTitle: chapter.title,
          fromPage: chapter.fromPage,
          definition: draft.definition,
        });
      }
      existing.definitionKeys.add(definitionKey(draft.definition));
      if (!concept.sources.some((s) => s.chapterTitle === source.chapterTitle && s.quote === source.quote)) {
        concept.sources.push(source);
      }
      // 新来源能定位到原文，整个概念就从"只是线索"变成"有据可查"
      if (source.verification !== "not_found") concept.verified = true;
      for (const point of draft.keyPoints) {
        if (!concept.keyPoints.some((p) => normalizeConceptName(p) === normalizeConceptName(point))) {
          concept.keyPoints.push(point);
        }
      }
      for (const prereq of draft.prerequisites) {
        if (!concept.prerequisites.some((p) => normalizeConceptName(p) === normalizeConceptName(prereq))) {
          concept.prerequisites.push(prereq);
        }
      }
    }
  }

  const concepts = [...byId.values()].map((acc) => acc.concept).sort((a, b) => a.title.localeCompare(b.title));

  // 先修名 → 书内概念 id；解析不到的就是悬空的，交给人看而不是悄悄丢掉
  const idByNormalized = new Map<string, string>();
  for (const concept of concepts) idByNormalized.set(normalizeConceptName(concept.title), concept.id);

  const links: CompiledBook["links"] = [];
  const unresolvedPrerequisites: CompiledBook["unresolvedPrerequisites"] = [];
  for (const concept of concepts) {
    for (const prereq of concept.prerequisites) {
      const fromId = idByNormalized.get(normalizeConceptName(prereq));
      if (!fromId || fromId === concept.id) {
        unresolvedPrerequisites.push({ conceptId: concept.id, title: prereq });
        continue;
      }
      if (!links.some((l) => l.from === fromId && l.to === concept.id)) {
        links.push({ from: fromId, to: concept.id, kind: "prerequisite" });
      }
    }
  }

  const chaptersWithConcepts = bodyChapters.filter((chapter) =>
    concepts.some((concept) => concept.sources.some((s) => s.chapterTitle === chapter.title)),
  ).length;

  return {
    title: options.title ?? "未命名教材",
    concepts,
    links,
    unresolvedPrerequisites,
    coverage: {
      chapters: bodyChapters.length,
      chaptersWithConcepts,
      concepts: concepts.length,
      verifiedConcepts: concepts.filter((c) => c.verified).length,
    },
    degraded,
  };
}

export interface CompiledDiff {
  added: { id: string; title: string }[];
  removed: { id: string; title: string }[];
  /** 同一个 id 但内容变了：哪些字段变了 */
  changed: { id: string; title: string; fields: ("definition" | "keyPoints" | "sources" | "conflicts")[] }[];
}

/**
 * 两版编译产物的差异。
 *
 * 这是"编译"这个词真正兑现的地方：调提示词、换模型、改切章之后，
 * 一眼能看出这一版动了哪些概念、是新增了还是定义改了。
 */
export function diffCompiled(prev: CompiledBook, next: CompiledBook): CompiledDiff {
  const prevById = new Map(prev.concepts.map((c) => [c.id, c]));
  const nextById = new Map(next.concepts.map((c) => [c.id, c]));

  const added = next.concepts.filter((c) => !prevById.has(c.id)).map((c) => ({ id: c.id, title: c.title }));
  const removed = prev.concepts.filter((c) => !nextById.has(c.id)).map((c) => ({ id: c.id, title: c.title }));

  const changed: CompiledDiff["changed"] = [];
  for (const concept of next.concepts) {
    const prevConcept = prevById.get(concept.id);
    if (!prevConcept) continue;
    const fields: CompiledDiff["changed"][number]["fields"] = [];
    if (definitionKey(prevConcept.definition) !== definitionKey(concept.definition)) fields.push("definition");
    if (prevConcept.keyPoints.length !== concept.keyPoints.length) fields.push("keyPoints");
    if (prevConcept.sources.length !== concept.sources.length) fields.push("sources");
    if (prevConcept.conflicts.length !== concept.conflicts.length) fields.push("conflicts");
    if (fields.length > 0) changed.push({ id: concept.id, title: concept.title, fields });
  }

  return { added, removed, changed };
}
