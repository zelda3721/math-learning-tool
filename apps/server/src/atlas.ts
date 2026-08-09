import { loadKnowledge, type Knowledge } from "@mathtutor/knowledge";
import path from "node:path";

let cached: Knowledge | null = null;

/** 知识层 file-first：从 data/knowledge/ 读取并经 schema 校验，进程内缓存（单向导入的派生只读视图）。 */
export function getKnowledge(dataDir: string): Knowledge {
  if (!cached) {
    cached = loadKnowledge({
      graphPath: path.join(dataDir, "knowledge", "graph.json"),
      problemsPath: path.join(dataDir, "knowledge", "problems.json"),
    });
  }
  return cached;
}

export function resetKnowledgeCache(): void {
  cached = null;
}
