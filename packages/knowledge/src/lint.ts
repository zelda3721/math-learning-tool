import type { Graph, KnowledgeLink, ProblemType, StageId } from "@mathtutor/schema";

const R: Record<StageId, number> = { primary: 0, junior: 1, senior: 2, university: 3 };
/**
 * 图谱没声明 strands 时的兜底（= 数学的四条主线）。
 * 有声明时一律以图谱自己声明的为准——把主线写死成数学这四条，
 * 英语的 vocabulary/grammar/reading 一进门就会被判非法。
 */
const DEFAULT_STRANDS = ["number-algebra", "geometry", "stats-prob", "thinking"];

export interface LintReport {
  errors: string[];
  warnings: string[];
  stats: { nodes: number; perStage: string; evoLinks: number; problems: number; links: number };
}

/**
 * 图谱/题型结构不变量校验（移植自 math-wiki scripts/lib/lint.mjs）。
 * 既当只读报告，也当 ingest 管线的闸门：errors 非空即拒绝写入。
 */
/** 学科 id 前缀的简写登记表（PLAN 里用的就是 en: 这种写法） */
export const SUBJECT_PREFIX_ALIASES: Record<string, string[]> = {
  english: ["en"],
  physics: ["phys"],
  chemistry: ["chem"],
};

export function lint(g: Graph, problems: ProblemType[] = [], links: KnowledgeLink[] = []): LintReport {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const ids = new Set(byId.keys());
  const nm = (i: string) => byId.get(i)?.name ?? i;
  const errors: string[] = [];
  const warnings: string[] = [];
  const strands = g.strands.length ? new Set(g.strands.map((s) => s.id)) : new Set(DEFAULT_STRANDS);

  if (ids.size !== g.nodes.length) errors.push("存在重复的 node id");

  for (const n of g.nodes) {
    if (!(n.stage in R)) errors.push(`学段非法: ${n.id} (${n.stage})`);
    if (!strands.has(n.strand)) errors.push(`主线非法: ${n.id} (${n.strand})`);
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
  /** 只在本学科内部算"能不能走到前沿"：靠数学节点走到大学，不能证明英语讲全了 */
  const reachesFrontier = (id: string, subject: string): boolean => {
    const seen = new Set([id]);
    const stk = [id];
    while (stk.length) {
      const u = stk.pop()!;
      if (byId.get(u)?.stage === "university") return true;
      for (const v of adjE.get(u) ?? []) {
        if (byId.get(v)?.subject !== subject) continue;
        if (!seen.has(v)) {
          seen.add(v);
          stk.push(v);
        }
      }
    }
    return false;
  };
  for (const n of g.nodes) {
    if (n.stage === "university") continue;
    // 数学图谱是"讲全了"的那一份，孤儿是硬错误。新学科刚接入时必然不完整，
    // 同一条规则先降级成警告——否则英语骨架第一天就过不了 lint，
    // 而人不该为了过闸门去编造"通往大学"的演化路径。
    const push = n.subject === "math" ? errors : warnings;
    const tag = n.subject === "math" ? "" : `（${n.subject} 尚未讲全）`;
    if (n.evolvesTo.length === 0) push.push(`孤儿(无后续演化): ${nm(n.id)}${tag}`);
    else if (!reachesFrontier(n.id, n.subject)) push.push(`无法到达前沿: ${nm(n.id)}${tag}`);
  }

  for (const n of g.nodes)
    for (const r of n.relatedTo) {
      const o = byId.get(r);
      if (o && !o.relatedTo.includes(n.id)) warnings.push(`相关不对称: ${nm(n.id)} ~ ${nm(r)}`);
    }

  // ── 学科命名空间 ──
  // 现有节点 id 一律不改（掌握度数据按 id 存着），但**新学科**的 id 必须带学科前缀，
  // 否则两门学科的 "present-simple" 迟早会撞在一起，而撞了之后没法自动分辨谁是谁。
  //
  // 前缀可以是学科全名，也可以是登记过的简写（PLAN 里举的例子就是 `en:`）。
  // 只认全名会把计划里的写法判成错，而"按计划写"不该报错。
  for (const n of g.nodes) {
    if (n.subject === "math") continue;
    const prefixes = [n.subject, ...(SUBJECT_PREFIX_ALIASES[n.subject] ?? [])];
    if (!prefixes.some((p) => n.id.startsWith(`${p}:`))) {
      errors.push(`学科前缀缺失: ${n.id}（subject=${n.subject} 应以 ${prefixes.map((p) => `${p}:`).join(" 或 ")} 开头）`);
    }
  }

  // ── 跨学科连接 ──
  const seenLink = new Set<string>();
  for (const l of links) {
    const from = byId.get(l.from);
    const to = byId.get(l.to);
    if (!from) errors.push(`连接起点悬挂: ${l.from} → ${l.to}`);
    if (!to) errors.push(`连接终点悬挂: ${l.from} → ${l.to}`);
    if (l.from === l.to) errors.push(`连接自环: ${l.from}`);
    const key = `${l.type}:${l.from}→${l.to}`;
    if (seenLink.has(key)) errors.push(`连接重复: ${key}`);
    seenLink.add(key);
    // 同学科的纵向关系在图谱里已经有 evolvesTo/prerequisites，再写一条 evolves 连接
    // 就是同一件事有两个真相来源，改了一处另一处不会跟着变
    if (from && to && from.subject === to.subject && l.type === "evolves") {
      warnings.push(`同学科演化应写进节点 evolvesTo，而不是连接表: ${l.from} → ${l.to}`);
    }
    if (from && to && from.subject === to.subject && l.type === "prerequisite") {
      warnings.push(`同学科先修应写进节点 prerequisites，而不是连接表: ${l.from} → ${l.to}`);
    }
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
    links: links.length,
  };
  return { errors, warnings, stats };
}
