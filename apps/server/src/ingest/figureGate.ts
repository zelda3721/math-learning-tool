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
/**
 * 「一条线段」的各种写法都归到 [起点, 终点]。
 * 实机上见过：["A","B"]、"AB"、{from,to}、{start,end}、{p1,p2}。
 */
function asSegment(v: unknown): [string, string] | undefined {
  if (Array.isArray(v) && v.length >= 2) return [String(v[0]), String(v[1])];
  if (typeof v === "string") {
    const pts = v.trim().split(/[\s,-]+/).filter(Boolean);
    if (pts.length >= 2) return [pts[0]!, pts[1]!];
    if (v.trim().length === 2) return [v.trim()[0]!, v.trim()[1]!];
    return undefined;
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const from = o.from ?? o.start ?? o.p1 ?? o.a;
    const to = o.to ?? o.end ?? o.p2 ?? o.b;
    if (typeof from === "string" && typeof to === "string") return [from, to];
  }
  return undefined;
}

/**
 * 从一条约束里找出**两条**线段。
 *
 * 两条线段要么装在一个数组字段里（lines/segments/points），
 * 要么摊成两组同名字段（a/b、line1/line2、from-to + from2-to2）。
 * 这两类分开处理，别的写法进来时也大多落得进其中一类。
 */
function segmentPair(q: Record<string, unknown>): [[string, string], [string, string]] | undefined {
  for (const key of ["lines", "segments", "points", "pairs"]) {
    const arr = q[key];
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const a = asSegment(arr[0]);
    const b = asSegment(arr[1]);
    if (a && b) return [a, b];
    // points:["A","B","C","D"] 意思是 AB 与 CD——四个点摊平写在一起
    if (arr.length >= 4 && arr.every((x) => typeof x === "string")) {
      return [
        [String(arr[0]), String(arr[1])],
        [String(arr[2]), String(arr[3])],
      ];
    }
  }
  const pairedKeys: [string, string][] = [
    ["a", "b"],
    ["line1", "line2"],
    ["first", "second"],
    ["segment1", "segment2"],
  ];
  for (const [ka, kb] of pairedKeys) {
    const a = asSegment(q[ka]);
    const b = asSegment(q[kb]);
    if (a && b) return [a, b];
  }
  const flat = asSegment({ from: q.from, to: q.to });
  const flat2 = asSegment({ from: q.from2, to: q.to2 });
  if (flat && flat2) return [flat, flat2];
  return undefined;
}

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
  if (Array.isArray(o.constraints)) {
    o.constraints = o.constraints.map((c) => {
      if (typeof c !== "object" || c === null) return c;
      const q = { ...(c as Record<string, unknown>) };
      // 常见写法：{"kind":"length","points":["A","B"]} / {"segment":"AB"} / {"between":["A","B"]}
      const pair =
        (Array.isArray(q.points) && q.points.length >= 2 ? q.points : undefined) ??
        (Array.isArray(q.between) && q.between.length >= 2 ? q.between : undefined) ??
        (typeof q.segment === "string" && q.segment.length === 2 ? [...q.segment] : undefined);
      if (q.from === undefined && pair) { q.from = String(pair[0]); q.to = String(pair[1]); }
      // 角写成 {"vertex":"B"} 或 {"points":["A","B","C"]}（中间那个是顶点）
      if (q.at === undefined && typeof q.vertex === "string") q.at = q.vertex;
      if ((q.kind === "angle" || q.kind === "right-angle") && q.at === undefined &&
          Array.isArray(q.points) && q.points.length >= 3) {
        q.from = String(q.points[0]); q.at = String(q.points[1]); q.to = String(q.points[2]);
      }
      // 度数字段名飘移
      if (q.degrees === undefined && typeof q.angle === "number") q.degrees = q.angle;
      if (q.degrees === undefined && typeof q.value === "number" && q.kind === "angle") q.degrees = q.value;
      // 直角写成 {"kind":"angle","degrees":90}
      if (q.kind === "angle" && q.degrees === 90) q.kind = "right-angle";
      // 点在线段上：schema 叫 point，模型跟着别的约束一起写成了 at
      if (q.kind === "on-segment" && q.point === undefined && typeof q.at === "string") {
        q.point = q.at;
      }
      // 平行/垂直/等长要的是**两条线段** a、b，而模型有无数种写法。
      // 与其一次次追加见过的那几种，不如把"什么算一条线段"和
      // "两条线段可能藏在哪些字段里"分开写清楚——后者按对出现，成对地找。
      if (q.kind === "parallel" || q.kind === "perpendicular" || q.kind === "equal-length") {
        const seg = asSegment(q.a) && asSegment(q.b)
          ? [asSegment(q.a)!, asSegment(q.b)!]
          : segmentPair(q);
        if (seg) {
          // zod 会自己剥掉多余字段，清掉只是不留下"同一件事写了两遍"的痕迹
          for (const k of ["from", "to", "from2", "to2", "lines", "segments", "points", "line1", "line2", "first", "second"]) {
            delete q[k];
          }
          [q.a, q.b] = seg;
        }
      }
      return q;
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

/**
 * 取出报错位置**所在的那个对象**（不是那个缺失的字段——它本来就不存在，
 * 打印出来是 undefined，等于什么都没说）。归一之后的形状，
 * 因为要回答的问题是"归一没能把它变成合法形状"。
 */
function snippetAt(root: unknown, path: (string | number)[]): string {
  let node: unknown = root;
  // 最后一段是出问题的字段名，往上退一层才是那个对象
  for (const key of path.slice(0, -1)) {
    if (node === null || typeof node !== "object") break;
    node = (node as Record<string | number, unknown>)[key];
  }
  try {
    const text = JSON.stringify(node ?? root);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "（无法序列化）";
  }
}

export function checkFigure(raw: unknown, stem: string): FigureCheck {
  if (raw === undefined || raw === null) return {};
  const coerced = coerceShape(raw);
  const parsed = FigureSpecSchema.safeParse(coerced);
  if (!parsed.success) {
    /**
     * 只说「constraints.0.a Required」，看的人还是不知道模型到底写了什么，
     * 于是只能一次次猜着补写法——我已经这么打了两轮地鼠了。
     * 把出问题的那一段原样附上，下次报错就自带答案。
     */
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "根对象";
    return {
      rejected: `配图规格不合法：${where} ${issue?.message ?? "未知"}；模型写的是 ${snippetAt(coerced, issue?.path ?? [])}`,
    };
  }
  const spec = parsed.data;

  /**
   * ⓪ 这到底是不是一张"图"。
   *
   * 约束才是图形的定义，坐标只是它的解。一条约束都没有时，求解器无事可违、
   * 一律判通过，于是我们会画出一张**随机摆放**的图去冒充这道题的配图。
   * 对数图形题这是致命的：题问的就是那个特定排布，摆错了答案就跟着错。
   *
   * 实测触发过：一道"手绢里有多少个三角形"，模型给了 52 个点（A…zz）、
   * 几百条线段、零条约束——它在描摹像素，不是在描述结构。
   * 点多到超出字母表也是同一个信号，一并拦下。
   */
  if (spec.constraints.length === 0) {
    return {
      rejected:
        "配图没有任何约束条件：这样画出来的位置全是随意摆的，" +
        "看着像这道题的图，其实不是",
    };
  }
  if (spec.points.length > 26) {
    return {
      rejected: `配图有 ${spec.points.length} 个点，已经不是「点线角」能说清的结构：多半是在描摹像素`,
    };
  }

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
