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

export interface ConceptSource {
  chapterTitle: string;
  fromPage: number;
  toPage: number;
  /** 原文片段：家长核对与后续对齐都靠它 */
  quote: string;
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
    .replace(/[（）()【】\[\]{}「」『』《》<>"'“”‘’.,，。、;；:：!！?？·—\-_/\\|~]+/g, "");
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
 * 编译一本书。
 *
 * 顺序：每章先问模型，失败/抽出空就退回离线兜底（如实标 degraded），
 * 然后按规范名合并跨章同名概念，最后把先修名解析成书内边。
 */
export async function compileBook(
  chapters: readonly Chapter[],
  options: { title?: string; provider?: ConceptExtractionProvider | null } = {},
): Promise<CompiledBook> {
  const bodyChapters = chapters.filter((c) => !c.backMatter);
  let degraded = false;

  const byId = new Map<string, Accumulator>();
  const idOwner = new Map<string, string>();

  for (const chapter of bodyChapters) {
    let drafts: ConceptDraft[] = [];
    if (options.provider) {
      try {
        drafts = sanitizeDrafts(await options.provider.extract({ chapterTitle: chapter.title, text: chapter.text }));
      } catch {
        drafts = [];
      }
    }
    // 模型不可用、或这一章什么都没抽出来：退回离线兜底，不让链停在这里
    if (drafts.length === 0) {
      drafts = compileChapterOffline(chapter);
      degraded = true;
    }

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
    coverage: { chapters: bodyChapters.length, chaptersWithConcepts, concepts: concepts.length },
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
