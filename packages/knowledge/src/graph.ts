import {
  MASTERY_PARAMS,
  type Application,
  type Graph,
  type KnowledgeNode,
  type StageId,
} from "@mathtutor/schema";

const STAGE_RANK: Record<StageId, number> = { primary: 0, junior: 1, senior: 2, university: 3 };

export interface MasteryLookup {
  (nodeId: string): { p: number; evidenceN: number } | undefined;
}

export interface RootCandidate {
  nodeId: string;
  /** 距出发节点的回溯深度（1 = 直接前置） */
  depth: number;
  p: number;
  evidenceN: number;
  reason: "low-mastery" | "no-evidence";
}

/**
 * 图索引与遍历（移植自 math-wiki src/graph.ts，模块级单例改为实例）。
 * 算法语义保持一致：演化光路贪心、前置主路径、传递闭包。
 */
export class GraphIndex {
  readonly graph: Graph;
  readonly nodeById: Map<string, KnowledgeNode>;
  private readonly reverseEvolveMap: Map<string, string[]>;

  constructor(graph: Graph) {
    this.graph = graph;
    this.nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    this.reverseEvolveMap = new Map();
    for (const n of graph.nodes) {
      for (const e of n.evolvesTo) {
        if (!this.nodeById.has(e.to)) continue;
        if (!this.reverseEvolveMap.has(e.to)) this.reverseEvolveMap.set(e.to, []);
        this.reverseEvolveMap.get(e.to)!.push(n.id);
      }
    }
  }

  getNode(id: string | null | undefined): KnowledgeNode | undefined {
    return id ? this.nodeById.get(id) : undefined;
  }

  /** 谁演化成了我（直接一层） */
  evolvedFrom(id: string): string[] {
    return this.reverseEvolveMap.get(id) ?? [];
  }

  /** 后续演化：沿 evolvesTo 可达的全部节点（不含自身） */
  descendants(id: string): Set<string> {
    const seen = new Set<string>();
    const stack = [...(this.getNode(id)?.evolvesTo ?? []).map((e) => e.to)];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of this.getNode(cur)?.evolvesTo ?? []) stack.push(e.to);
    }
    return seen;
  }

  /** 演化祖先：沿 evolvesTo 反向传递闭包（不含自身） */
  evolutionAncestors(id: string): Set<string> {
    const seen = new Set<string>();
    const stack = [...this.evolvedFrom(id)];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.evolvedFrom(cur)) stack.push(p);
    }
    return seen;
  }

  /** 前置祖先：沿 prerequisites 传递闭包（不含自身） */
  ancestors(id: string): Set<string> {
    const seen = new Set<string>();
    const stack = [...(this.getNode(id)?.prerequisites ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur) || !this.nodeById.has(cur)) continue;
      seen.add(cur);
      for (const p of this.getNode(cur)?.prerequisites ?? []) stack.push(p);
    }
    return seen;
  }

  private isFrontier(n: KnowledgeNode): boolean {
    return n.stage === "university" || n.applications.some((a) => a.frontier);
  }

  /** 演化主路径：贪心选「能到达最高学段/前沿」的后继（演化光路/学习路径右段） */
  evolutionPath(id: string): { from: string; to: string; how: string }[] {
    const path: { from: string; to: string; how: string }[] = [];
    const visited = new Set<string>([id]);
    let cur = id;
    for (let guard = 0; guard < 12; guard++) {
      const links = (this.getNode(cur)?.evolvesTo ?? []).filter(
        (e) => this.nodeById.has(e.to) && !visited.has(e.to),
      );
      if (!links.length) break;
      links.sort((a, b) => {
        const na = this.getNode(a.to)!;
        const nb = this.getNode(b.to)!;
        const fa = (this.isFrontier(na) ? 10 : 0) + this.descendants(a.to).size + STAGE_RANK[na.stage];
        const fb = (this.isFrontier(nb) ? 10 : 0) + this.descendants(b.to).size + STAGE_RANK[nb.stage];
        return fb - fa;
      });
      const next = links[0]!;
      path.push({ from: cur, to: next.to, how: next.how });
      visited.add(next.to);
      cur = next.to;
    }
    return path;
  }

  /** 前置主路径：回溯到最早的根（学习路径左段） */
  prereqPath(id: string): string[] {
    const path: string[] = [];
    const visited = new Set<string>([id]);
    let cur = id;
    for (let guard = 0; guard < 12; guard++) {
      const prereqs = (this.getNode(cur)?.prerequisites ?? []).filter(
        (p) => this.nodeById.has(p) && !visited.has(p),
      );
      if (!prereqs.length) break;
      prereqs.sort((a, b) => STAGE_RANK[this.getNode(a)!.stage] - STAGE_RANK[this.getNode(b)!.stage]);
      const prev = prereqs[0]!;
      path.unshift(prev);
      visited.add(prev);
      cur = prev;
    }
    return path;
  }

  /** 节点自身应用（前沿优先；不向下传播，避免基础节点挂牵强前沿） */
  reachableApplications(id: string): { app: Application; nodeId: string }[] {
    const out = (this.getNode(id)?.applications ?? []).map((app) => ({ app, nodeId: id }));
    out.sort((a, b) => Number(b.app.frontier ?? false) - Number(a.app.frontier ?? false));
    return out;
  }

  /** 完整学习路径：前置 → 当前 → 后续演化 */
  learningPath(id: string): {
    before: string[];
    current: string;
    after: { from: string; to: string; how: string }[];
  } {
    return { before: this.prereqPath(id), current: id, after: this.evolutionPath(id) };
  }

  /**
   * 诊断归因候选：沿 prerequisites 回溯（BFS），返回掌握度低于阈值或无证据的祖先。
   * 归因主链是代码，LLM 只在这个候选集内做受限选择（设计 §06/§07）。
   */
  traceRootCandidates(
    nodeIds: string[],
    mastery: MasteryLookup,
    thresholdP: number = MASTERY_PARAMS.rootCandidateThresholdP,
  ): RootCandidate[] {
    const out = new Map<string, RootCandidate>();
    const queue: { id: string; depth: number }[] = [];
    const seen = new Set<string>(nodeIds);
    for (const id of nodeIds) {
      for (const p of this.getNode(id)?.prerequisites ?? []) queue.push({ id: p, depth: 1 });
    }
    while (queue.length) {
      const { id, depth } = queue.shift()!;
      if (seen.has(id) || !this.nodeById.has(id)) continue;
      seen.add(id);
      const m = mastery(id);
      if (m === undefined || m.evidenceN === 0) {
        out.set(id, { nodeId: id, depth, p: m?.p ?? 0, evidenceN: m?.evidenceN ?? 0, reason: "no-evidence" });
      } else if (m.p < thresholdP) {
        out.set(id, { nodeId: id, depth, p: m.p, evidenceN: m.evidenceN, reason: "low-mastery" });
      }
      for (const p of this.getNode(id)?.prerequisites ?? []) queue.push({ id: p, depth: depth + 1 });
    }
    return [...out.values()].sort((a, b) => a.depth - b.depth || a.p - b.p);
  }
}
