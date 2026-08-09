import type { Graph, ProblemType, StageId } from "@mathtutor/schema";

const R: Record<StageId, number> = { primary: 0, junior: 1, senior: 2, university: 3 };
const STRANDS = ["number-algebra", "geometry", "stats-prob", "thinking"];

export interface LintReport {
  errors: string[];
  warnings: string[];
  stats: { nodes: number; perStage: string; evoLinks: number; problems: number };
}

/**
 * 图谱/题型结构不变量校验（移植自 math-wiki scripts/lib/lint.mjs）。
 * 既当只读报告，也当 ingest 管线的闸门：errors 非空即拒绝写入。
 */
export function lint(g: Graph, problems: ProblemType[] = []): LintReport {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const ids = new Set(byId.keys());
  const nm = (i: string) => byId.get(i)?.name ?? i;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (ids.size !== g.nodes.length) errors.push("存在重复的 node id");

  for (const n of g.nodes) {
    if (!(n.stage in R)) errors.push(`学段非法: ${n.id} (${n.stage})`);
    if (!STRANDS.includes(n.strand)) errors.push(`主线非法: ${n.id} (${n.strand})`);
    for (const e of n.evolvesTo) {
      if (!ids.has(e.to)) errors.push(`悬挂演化: ${n.id} → ${e.to}`);
      else {
        if (e.to === n.id) errors.push(`自环演化: ${n.id}`);
        if (R[byId.get(e.to)!.stage] < R[n.stage])
          errors.push(`反向演化(指向更早学段): ${nm(n.id)} → ${nm(e.to)}`);
      }
    }
    for (const p of n.prerequisites) {
      if (!ids.has(p)) errors.push(`悬挂前置: ${n.id} ← ${p}`);
      else if (R[byId.get(p)!.stage] > R[n.stage])
        errors.push(`反向前置(指向更晚学段): ${nm(n.id)} ← ${nm(p)}`);
    }
    for (const r of n.relatedTo) if (!ids.has(r)) errors.push(`悬挂相关: ${n.id} ~ ${r}`);
  }

  const findCycles = (adj: Map<string, string[]>): string[] => {
    const st = new Map<string, number>();
    const found: string[] = [];
    const dfs = (u: string, path: string[]): void => {
      st.set(u, 1);
      for (const v of adj.get(u) ?? []) {
        if (st.get(v) === 1) found.push(path.concat(v).map(nm).join("→"));
        else if (!st.get(v)) dfs(v, path.concat(v));
      }
      st.set(u, 2);
    };
    for (const n of g.nodes) if (!st.get(n.id)) dfs(n.id, [n.id]);
    return found;
  };
  findCycles(
    new Map(g.nodes.map((n) => [n.id, n.evolvesTo.map((e) => e.to).filter((t) => ids.has(t))])),
  ).forEach((c) => errors.push(`演化环: ${c}`));
  findCycles(
    new Map(g.nodes.map((n) => [n.id, n.prerequisites.filter((t) => ids.has(t))])),
  ).forEach((c) => errors.push(`前置环: ${c}`));

  const adjE = new Map(g.nodes.map((n) => [n.id, n.evolvesTo.map((e) => e.to)]));
  const reachesFrontier = (id: string): boolean => {
    const seen = new Set([id]);
    const stk = [id];
    while (stk.length) {
      const u = stk.pop()!;
      if (byId.get(u)?.stage === "university") return true;
      for (const v of adjE.get(u) ?? []) {
        if (!seen.has(v)) {
          seen.add(v);
          stk.push(v);
        }
      }
    }
    return false;
  };
  for (const n of g.nodes) {
    if (n.stage !== "university" && n.evolvesTo.length === 0)
      errors.push(`孤儿(无后续演化): ${nm(n.id)}`);
    else if (n.stage !== "university" && !reachesFrontier(n.id))
      errors.push(`无法到达前沿: ${nm(n.id)}`);
  }

  for (const n of g.nodes)
    for (const r of n.relatedTo) {
      const o = byId.get(r);
      if (o && !o.relatedTo.includes(n.id)) warnings.push(`相关不对称: ${nm(n.id)} ~ ${nm(r)}`);
    }

  const pIds = new Set<string>();
  for (const p of problems) {
    if (pIds.has(p.id)) errors.push(`重复题型 id: ${p.id}`);
    pIds.add(p.id);
    if (!(p.stage in R)) errors.push(`题型学段非法: ${p.id} (${p.stage})`);
    for (const nid of p.nodes) if (!ids.has(nid)) errors.push(`题型悬挂知识点: ${p.id} → ${nid}`);
    if (p.unifiedBy?.node && !ids.has(p.unifiedBy.node))
      errors.push(`题型悬挂演化节点: ${p.id} → ${p.unifiedBy.node}`);
    if (/奥数/.test(p.category ?? "")) warnings.push(`题型分类含"奥数": ${p.id}`);
  }

  const stats = {
    nodes: g.nodes.length,
    perStage: (["primary", "junior", "senior", "university"] as const)
      .map((s) => `${s}:${g.nodes.filter((n) => n.stage === s).length}`)
      .join(" "),
    evoLinks: g.nodes.reduce((a, n) => a + n.evolvesTo.length, 0),
    problems: problems.length,
  };
  return { errors, warnings, stats };
}
