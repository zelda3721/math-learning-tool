import type { KnowledgeLink } from "@mathtutor/schema";
import type { GraphIndex } from "./graph.js";

/**
 * 跨学科连接：一个知识点在别的学科里怎么用。
 *
 * 这里的价值不在"有关系"三个字，而在于**具体到能判断**：哪一步用上、
 * 用错了会错在哪。`links.json` 里的 note 就是按这个标准写的，
 * 所以这个模块只负责配对与呈现，不再自己编理由。
 *
 * 约定：
 * - 只呈现**双向**都找得到对方节点的边：目标节点缺失时宁可不显示，
 *   也不显示一个点不进去的死链；
 * - `applies`（应用）与 `analogy`（类比）是同一次"综合运用"的两种形态，
 *   一个说"用得上"，一个说"想得通"，界面上不必混成一句；
 * - `prerequisite`/`evolves` 属于纵向关系，这里只透传不解读。
 */

export interface CrossSubjectMember {
  /** 对方节点 id */
  nodeId: string;
  nodeName: string;
  /** 对方学科（math / english / …） */
  subject: string;
  /** 对方在哪个学段 */
  stage: string;
  type: KnowledgeLink["type"];
  /** 连接说明：具体到哪一步用上 */
  note: string;
  /** 依据，便于家长核对 */
  source?: string;
  /** 从当前节点看，这条边是"出去"还是"进来" */
  direction: "out" | "in";
}

function nodeMeta(index: GraphIndex, nodeId: string): { name: string; subject: string; stage: string } | null {
  const node = index.getNode(nodeId);
  if (!node) return null;
  const raw = node as unknown as { subject?: string; stage?: string };
  return { name: node.name, subject: raw.subject ?? "math", stage: raw.stage ?? "" };
}

/** 与某个节点相连的跨学科成员（不含同学科的边：那些看 prerequisites 就够了） */
export function crossSubjectMembers(
  index: GraphIndex,
  links: readonly KnowledgeLink[],
  nodeId: string,
): CrossSubjectMember[] {
  const self = nodeMeta(index, nodeId);
  if (!self) return [];

  const out: CrossSubjectMember[] = [];
  for (const link of links) {
    const otherId = link.from === nodeId ? link.to : link.to === nodeId ? link.from : null;
    if (!otherId) continue;
    const other = nodeMeta(index, otherId);
    // 目标节点不在图谱里：宁可少显示，也不显示点不开的链接
    if (!other) continue;
    if (other.subject === self.subject) continue;
    out.push({
      nodeId: otherId,
      nodeName: other.name,
      subject: other.subject,
      stage: other.stage,
      type: link.type,
      note: link.note,
      source: link.source,
      direction: link.from === nodeId ? "out" : "in",
    });
  }
  // 同一条边在两个方向上都可能出现；按对方 id + 类型去重
  const seen = new Set<string>();
  return out.filter((member) => {
    const key = `${member.nodeId}:${member.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 整张跨学科表的体检结果：悬空端点、同学科内的连接、重复边都算问题 */
export function auditLinks(
  index: GraphIndex,
  links: readonly KnowledgeLink[],
): { problems: string[]; crossSubjectCount: number } {
  const problems: string[] = [];
  let crossSubjectCount = 0;
  const seen = new Set<string>();

  for (const link of links) {
    const from = nodeMeta(index, link.from);
    const to = nodeMeta(index, link.to);
    if (!from) problems.push(`from 不存在：${link.from}`);
    if (!to) problems.push(`to 不存在：${link.to}`);
    if (from && to) {
      if (from.subject === to.subject) {
        problems.push(`同学科连线应写在节点里：${link.from} → ${link.to}`);
      } else {
        crossSubjectCount += 1;
      }
    }
    const key = `${link.from}->${link.to}:${link.type}`;
    if (seen.has(key)) problems.push(`重复边：${key}`);
    seen.add(key);
    if (link.note.trim().length < 8) problems.push(`note 太笼统：${link.from} → ${link.to}`);
  }

  return { problems, crossSubjectCount };
}

/** 学科的中文名（界面显示用；没登记的学科原样返回） */
export const SUBJECT_LABEL: Record<string, string> = {
  math: "数学",
  english: "英语",
  physics: "物理",
};
