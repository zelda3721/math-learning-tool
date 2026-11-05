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
}): Knowledge {
  const graph = GraphSchema.parse(JSON.parse(readFileSync(paths.graphPath, "utf8")));
  const problemTypes = ProblemTypesSchema.parse(
    JSON.parse(readFileSync(paths.problemsPath, "utf8")),
  );
  const links =
    paths.linksPath && existsSync(paths.linksPath)
      ? LinksFileSchema.parse(JSON.parse(readFileSync(paths.linksPath, "utf8"))).links
      : [];
  return { graph, problemTypes, links, index: new GraphIndex(graph) };
}
