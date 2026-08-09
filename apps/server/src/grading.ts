import { create, all, type MathNode } from "mathjs";
import type { Question } from "@mathtutor/schema";

const math = create(all!, {});

export interface GradeResult {
  correct: boolean;
  /** deterministic=程序判定；pending=主观步骤，进家长判卷抽检队列 */
  method: "numeric" | "expression" | "string" | "pending";
}

/** 全角→半角 + 去空白 + 统一小写（判卷输入规范化） */
export function normalizeText(raw: string): string {
  return raw
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[×✕]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/[，]/g, ",")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * 提取数值：支持整数/小数/分数 a/b（含带分数 c又a/b 不支持，P1a 范围外）/百分数。
 * 学生答案常带单位（"26 厘米"）——按 answerType=numeric 提取数值比对。
 */
export function parseNumeric(raw: string): number | null {
  const text = normalizeText(raw);
  const percent = text.match(/(-?\d+(?:\.\d+)?)%/);
  if (percent) return Number(percent[1]) / 100;
  const fraction = text.match(/(-?\d+)\/(\d+)/);
  if (fraction) {
    const den = Number(fraction[2]);
    if (den === 0) return null;
    return Number(fraction[1]) / den;
  }
  const num = text.match(/-?\d+(?:\.\d+)?/);
  return num ? Number(num[0]) : null;
}

function numbersClose(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

/** 表达式等价：mathjs 解析 + 随机采样多点求值一致（防「化简形式不同判错」） */
export function expressionsEquivalent(canonical: string, student: string): boolean {
  let nodeA: MathNode;
  let nodeB: MathNode;
  try {
    nodeA = math.parse(normalizeExpressionInput(canonical));
    nodeB = math.parse(normalizeExpressionInput(student));
  } catch {
    return false;
  }
  const symbols = new Set<string>();
  for (const node of [nodeA, nodeB]) {
    node.traverse((n) => {
      if (n.type === "SymbolNode") symbols.add((n as unknown as { name: string }).name);
    });
  }
  const compiledA = nodeA.compile();
  const compiledB = nodeB.compile();
  let comparisons = 0;
  for (let trial = 0; trial < 24 && comparisons < 5; trial++) {
    const scope: Record<string, number> = {};
    for (const s of symbols) scope[s] = pseudoRandom(trial, s) * 6 - 3;
    let a: unknown;
    let b: unknown;
    try {
      a = compiledA.evaluate(scope);
      b = compiledB.evaluate(scope);
    } catch {
      continue;
    }
    if (typeof a !== "number" || typeof b !== "number" || !isFinite(a) || !isFinite(b)) continue;
    if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))) return false;
    comparisons++;
  }
  return comparisons >= 3;
}

/** 确定性伪随机（判卷必须可复现，禁 Math.random） */
function pseudoRandom(trial: number, symbol: string): number {
  let h = 2166136261 ^ trial;
  for (const ch of symbol) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

function normalizeExpressionInput(raw: string): string {
  // "x=4" 形式取右侧；中文乘除号已在 normalizeText 处理，这里保留大小写与空格给 mathjs
  const text = raw
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[×✕]/g, "*")
    .replace(/[÷]/g, "/")
    .trim();
  const eq = text.split("=");
  return (eq.length === 2 ? eq[1]! : text).trim();
}

export function grade(question: Pick<Question, "answer" | "answerType">, studentAnswer: string): GradeResult {
  const student = studentAnswer.trim();
  if (!student) return { correct: false, method: "string" };
  switch (question.answerType) {
    case "numeric": {
      const expected = parseNumeric(question.answer);
      const got = parseNumeric(student);
      if (expected !== null && got !== null)
        return { correct: numbersClose(expected, got), method: "numeric" };
      return { correct: normalizeText(question.answer) === normalizeText(student), method: "string" };
    }
    case "expression": {
      if (expressionsEquivalent(question.answer, student))
        return { correct: true, method: "expression" };
      // 数值型表达式答案（如方程解 x=4 vs 4）再给一次数值比对机会
      const expected = parseNumeric(question.answer);
      const got = parseNumeric(student);
      if (expected !== null && got !== null && numbersClose(expected, got))
        return { correct: true, method: "numeric" };
      return { correct: false, method: "expression" };
    }
    case "steps":
      // 主观步骤：P1a 不做 LLM 判卷，标 pending 进家长抽检；不计入掌握度
      return { correct: false, method: "pending" };
  }
}
