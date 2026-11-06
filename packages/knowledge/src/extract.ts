import type { Chapter } from "./chapters.js";

/**
 * 知识点抽取：把一章正文切成若干个"知识点",每个都带着它能站得住的原文。
 *
 * 为什么必须有 `evidence`：对齐那一步是拿文本去匹配图谱节点，匹配得准不准，
 * 取决于喂进去的文本**是不是一个知识点**。整章喂进去，匹配到的是"这一章最像哪个节点"，
 * 而不是"这里讲的这个知识点是哪个节点"——章越长越糊。
 *
 * 为什么要有离线兜底：模型不可用时整条教材编译链会停住，而停住的地方恰恰是
 * 家长最想先看看"这本书大概能对上哪些知识点"。兜底给出的候选质量低一档，
 * 但它带着 evidence，家长一眼能看出"这条抽得不对"，而不是面对一个空白页。
 */

export interface KnowledgePointDraft {
  /** 知识点名（尽量短，能对上图谱里的节点名） */
  title: string;
  /** 用原文拼出的一句话概述 */
  summary: string;
  /** 支撑这个知识点的原文片段：对齐与家长核对都靠它 */
  evidence: string;
}

export interface DraftExtractionProvider {
  extract(input: { chapterTitle: string; text: string }): Promise<KnowledgePointDraft[]>;
}

/** 抽取结果的合理上限：一章抽出几十个"知识点"多半是切碎了，反而没法对齐 */
const MAX_DRAFTS = 12;

/** 一条知识点至少要有这么多字，否则它撑不起一次对齐 */
const MIN_EVIDENCE_CHARS = 12;

/**
 * 离线兜底：按段落聚合，取每段首句做标题。
 *
 * 刻意不做"关键词提取"那种聪明事：没有模型时，能确定的是**段落边界**，
 * 而不是哪个词更重要。装作知道，家长就得逐个纠正。
 */
export function extractOffline(chapter: Chapter): KnowledgePointDraft[] {
  const paragraphs = chapter.text
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length >= MIN_EVIDENCE_CHARS);

  const drafts: KnowledgePointDraft[] = [];
  for (const para of paragraphs) {
    if (drafts.length >= MAX_DRAFTS) break;
    const firstSentence = para.split(/[。！？!?]/)[0]?.trim() ?? para;
    const title = (firstSentence || para).slice(0, 16);
    drafts.push({
      title,
      summary: firstSentence.slice(0, 60),
      evidence: para.slice(0, 400),
    });
  }
  return drafts;
}

/**
 * 抽取一章的知识点。
 *
 * 顺序：先问模型，失败或结果不可用就退回离线兜底。
 * 模型给出空数组也走兜底——"抽不出东西"和"模型坏了"对家长是同一件事，
 * 而空清单帮不了他做任何判断。
 */
export async function extractKnowledgePoints(
  chapter: Chapter,
  provider?: DraftExtractionProvider,
): Promise<{ drafts: KnowledgePointDraft[]; degraded: boolean }> {
  if (provider) {
    try {
      const raw = await provider.extract({ chapterTitle: chapter.title, text: chapter.text });
      const usable = raw
        .filter((d) => typeof d.title === "string" && d.title.trim())
        .filter((d) => typeof d.evidence === "string" && d.evidence.trim().length >= MIN_EVIDENCE_CHARS)
        .slice(0, MAX_DRAFTS)
        // 证据不足的草稿直接丢掉：留着会让对齐凭空多出几个没依据的候选
        .map((d) => ({
          title: d.title.trim().slice(0, 40),
          summary: (d.summary ?? "").trim(),
          evidence: d.evidence.trim().slice(0, 400),
        }));
      if (usable.length > 0) return { drafts: usable, degraded: false };
    } catch {
      // 模型不可用：往下走兜底，不把整条链停在这里
    }
  }
  return { drafts: extractOffline(chapter), degraded: true };
}
