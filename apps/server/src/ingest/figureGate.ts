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

export function checkFigure(raw: unknown, stem: string): FigureCheck {
  if (raw === undefined || raw === null) return {};
  const parsed = FigureSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return { rejected: `配图规格不合法：${parsed.error.issues[0]?.message ?? "未知"}` };
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
