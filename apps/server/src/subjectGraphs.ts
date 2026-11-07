import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 各学科图谱的路径（`subjects/<subject>/graph.json`）。
 *
 * 集中一处，是因为有两个地方必须用同一份清单：启动时加载知识层、
 * 以及知识层管理通道写文件前的 lint。少挂一处，就会出现"启动能过、核验被拒"
 * （实机：连接表里已经有 en: 节点，而 verifyNode 的 lint 只看数学图，
 * 于是每条跨学科连接都被判成悬挂）。
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export const SUBJECT_GRAPH_PATHS: string[] = [path.join(repoRoot, "subjects", "english", "graph.json")];
