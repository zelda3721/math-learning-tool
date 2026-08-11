/**
 * 抽取出来的配图要过两道关，一道都不能少。
 *
 * ① 解得出来吗——把点线角与约束交给求解器，解不出就说明这组约束自相矛盾。
 * ② 图上的数字是不是题干里的——这一关比第一关更要紧。
 *    模型看图写规格时最容易犯的错不是写出矛盾的约束（那会被第一关拦下），
 *    而是**把图上量到的、题干并没有给的长度也写进去**：一张自洽却多出条件的图，
 *    会让孩子"看图就能得到答案"，而这道题本来是要他推的。
 *
 * 两关任一不过，就丢掉配图、保留题目本身（退回纯文字），并说明原因给家长抽检。
 * 不整题丢弃：题干通常是好的，坏的只是那张图。
 */
import { FigureSpecSchema, type FigureSpec } from "@mathtutor/schema";
import { solveFigure } from "@mathtutor/explainer-web";

export interface FigureCheck {
  figure?: FigureSpec;
  /** 丢弃原因；figure 存在时为空 */
  rejected?: string;
}

/** 题干里出现过的数值（含中文数字场景下的阿拉伯数字部分） */
function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)]
    .map((m) => Number(m[0]))
    .filter((n) => Number.isFinite(n));
}

/** 约束里声明的每一个数值 */
function declaredValues(spec: FigureSpec): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  for (const c of spec.constraints) {
    if (c.kind === "length") out.push({ label: `${c.from}${c.to} 的长度`, value: c.value });
    // 直角是普遍约定（不必在题干里写 90），其余角度必须有出处
    if (c.kind === "angle") out.push({ label: `∠${c.from}${c.at}${c.to}`, value: c.degrees });
  }
  return out;
}

/**
 * 模型给的形状不会完全照着 schema 来，常见几种先归一，别为格式小事丢掉一张好图：
 * - points 写成 ["A","B","C"] 而不是 [{id:"A"}]
 * - 顶点用 name/label 而不是 id
 * - segments 用 [a,b] 数组或 {start,end}
 * 归一改的只是"怎么写"，不改"图是什么"——真实性仍由下面两道关把守。
 */
function coerceShape(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(o.points)) {
    o.points = o.points.map((p) => {
      if (typeof p === "string") return { id: p };
      if (typeof p === "object" && p !== null) {
        const q = p as Record<string, unknown>;
        if (q.id === undefined && typeof q.name === "string") return { ...q, id: q.name };
        if (q.id === undefined && typeof q.label === "string") return { ...q, id: q.label };
      }
      return p;
    });
  }
  if (Array.isArray(o.segments)) {
    o.segments = o.segments.map((seg) => {
      if (Array.isArray(seg) && seg.length >= 2) return { from: String(seg[0]), to: String(seg[1]) };
      if (typeof seg === "object" && seg !== null) {
        const q = seg as Record<string, unknown>;
        if (q.from === undefined && q.start !== undefined) return { ...q, from: q.start, to: q.end };
      }
      return seg;
    });
  }
  return o;
}

export function checkFigure(raw: unknown, stem: string): FigureCheck {
  if (raw === undefined || raw === null) return {};
  const parsed = FigureSpecSchema.safeParse(coerceShape(raw));
  if (!parsed.success) {
    // 只说 "Required" 事后谁也查不出是哪个字段——把路径带上
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "根对象";
    return { rejected: `配图规格不合法：${where} ${issue?.message ?? "未知"}` };
  }
  const spec = parsed.data;

  // ② 数字出处：图上标的量必须能在题干里找到
  const known = numbersIn(stem);
  const invented = declaredValues(spec).filter(
    (d) => !known.some((n) => Math.abs(n - d.value) < 1e-6),
  );
  if (invented.length > 0) {
    return {
      rejected:
        `配图给出了题干没有的条件（${invented.map((d) => `${d.label}=${d.value}`).join("、")}）：` +
        "这会让孩子看图就得到答案，而这道题本来要他推",
    };
  }

  // ① 解得出来吗
  const solved = solveFigure(spec);
  if (!solved.ok) {
    return { rejected: `配图的条件自相矛盾，画不出来：${solved.violations.slice(0, 2).join("；")}` };
  }
  return { figure: spec };
}
