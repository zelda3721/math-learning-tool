import { readFileSync } from "node:fs";
import { GraphSchema, ProblemTypesSchema, type Graph, type ProblemType } from "@mathtutor/schema";
import { GraphIndex } from "./graph.js";

export interface Knowledge {
  graph: Graph;
  problemTypes: ProblemType[];
  index: GraphIndex;
}

/** 从 data/knowledge/ 读取并经 schema 校验（file-first 知识层的唯一读取入口） */
export function loadKnowledge(paths: { graphPath: string; problemsPath: string }): Knowledge {
  const graph = GraphSchema.parse(JSON.parse(readFileSync(paths.graphPath, "utf8")));
  const problemTypes = ProblemTypesSchema.parse(
    JSON.parse(readFileSync(paths.problemsPath, "utf8")),
  );
  return { graph, problemTypes, index: new GraphIndex(graph) };
}
