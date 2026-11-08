import { readFileSync, existsSync } from "node:fs";
import {
  GraphSchema,
  LinksFileSchema,
  ProblemTypesSchema,
  type Graph,
  type KnowledgeLink,
  type ProblemType,
} from "@mathtutor/schema";
import { GraphIndex } from "./graph.js";

export interface Knowledge {
  graph: Graph;
  problemTypes: ProblemType[];
  /** 跨学科连接（links.json）；文件不存在时为空数组——它不是必需品，是增强 */
  links: KnowledgeLink[];
  index: GraphIndex;
}

/**
 * 从 data/knowledge/ 读取并经 schema 校验（file-first 知识层的唯一读取入口）。
 *
 * `linksPath` 可省略：没有跨学科连接文件也能正常工作，只是"这个知识在别的学科
 * 里怎么用"那条通路没有内容可显示。
 */
export function loadKnowledge(paths: {
  graphPath: string;
  problemsPath: string;
  linksPath?: string;
  /**
   * 其他学科的图谱（`subjects/<subject>/graph.json`）。
   *
   * 合并进同一张图而不是各查各的：星图、掌握度、跨学科连接都要按 id 互相找得到，
   * 分两套索引会让「这个知识点在英语里怎么用」变成一次跨库拼装。
   * 学科之间靠节点的 subject 字段区分，id 靠前缀（en:）保证不撞。
   */
  subjectGraphPaths?: string[];
}): Knowledge {
  const graph = mergeSubjectGraphs(
    GraphSchema.parse(JSON.parse(readFileSync(paths.graphPath, "utf8"))),
    (paths.subjectGraphPaths ?? []).filter((file) => existsSync(file)).map((file) =>
      GraphSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
    ),
  );
  const problemTypes = ProblemTypesSchema.parse(
    JSON.parse(readFileSync(paths.problemsPath, "utf8")),
  );
  const links =
    paths.linksPath && existsSync(paths.linksPath)
      ? LinksFileSchema.parse(JSON.parse(readFileSync(paths.linksPath, "utf8"))).links
      : [];
  return { graph, problemTypes, links, index: new GraphIndex(graph) };
}


/**
 * 把学科图合并进主图。
 *
 * 只做并集，不做去重合并：节点 id 撞了属于配置错误，应当由 lint 报出来，
 * 而不是在加载时悄悄丢掉一个学科的知识点。
 */
export function mergeSubjectGraphs(base: Graph, extras: readonly Graph[]): Graph {
  if (extras.length === 0) return base;
  const nodes = [...base.nodes];
  for (const extra of extras) nodes.push(...extra.nodes);

  const byId = <T extends { id: string }>(groups: readonly (readonly T[])[]): T[] => {
    const seen = new Map<string, T>();
    for (const group of groups) for (const item of group) if (!seen.has(item.id)) seen.set(item.id, item);
    return [...seen.values()];
  };

  const anyGraph = base as unknown as { stages?: { id: string }[]; strands?: { id: string }[] };
  const extraMeta = extras.map((g) => g as unknown as { stages?: { id: string }[]; strands?: { id: string }[] });

  return {
    ...base,
    nodes,
    ...(anyGraph.stages
      ? { stages: byId([anyGraph.stages, ...extraMeta.map((g) => g.stages ?? [])]) }
      : {}),
    ...(anyGraph.strands
      ? { strands: byId([anyGraph.strands, ...extraMeta.map((g) => g.strands ?? [])]) }
      : {}),
  } as Graph;
}
