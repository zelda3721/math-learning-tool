import { create, all, type MathNode } from "mathjs";
import type { Question } from "@mathtutor/schema";

const math = create(all!, {});

/**
 * 判卷。
 *
 * 参考答案是从讲义上原样读下来的一串文字（题库里没有结构化答案），
 * 所以判卷器要自己把它拆开理解。三条纪律：
 *
 * ① **形式不同不算错**：单位、空格、全角半角、分数与小数、代数式的等价变形，
 *    都要认。孩子写「26 厘米」和参考答案「26」是同一件事。
 * ② **只答一半不算对**。曾经只比"两边各自的第一个数"，于是参考答案
 *    「44，20」而孩子只写「44」判成对、「少22人」和「多22人」也判成对——
 *    后者尤其糟，那道题考的就是多还是少。
 * ③ **判不准就别判**：转成 pending 交给家长，而不是武断判错。
 *    判错一次，孩子会开始怀疑自己而不是怀疑系统。
 *
 * answerType 只作参考、不作依据：实测题库里 13 道纯文字题被标成 expression、
 * 2 道纯数值题被标成 steps（于是永远得不到反馈）。判卷策略由答案本身推导。
 */

export interface GradeResult {
  correct: boolean;
  /** deterministic=程序判定；pending=判不准，进家长判卷抽检队列 */
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

// ---------------------------------------------------------------------------
// 数值解析
// ---------------------------------------------------------------------------

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

/**
 * 纯中文数字 → 阿拉伯数字（十、二十五、一百零三）。
 *
 * **只在整串都是中文数字时才转**。否则「二小」会变成「2小」、
 * 「三个和尚」会变成「3个和尚」，把文字答案搅烂。
 */
export function parseChineseNumber(text: string): number | null {
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(text)) return null;
  let total = 0;
  let section = 0;
  let current = 0;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch]!;
    } else if (ch === "十") {
      section += (current || 1) * 10;
      current = 0;
    } else if (ch === "百") {
      section += (current || 1) * 100;
      current = 0;
    } else if (ch === "千") {
      section += (current || 1) * 1000;
      current = 0;
    }
  }
  total += section + current;
  return Number.isFinite(total) ? total : null;
}

/**
 * 去掉小问的编号：「(1) 4500」里的 (1) 不是答案。
 *
 * 只剥括号形式与带圈数字——「44」这种裸数字本身就是答案，不能剥。
 * 曾经吃过亏：参考答案「( 1 ) 9021 . ( 2 ) 1909 .」判卷时抓到的是题号 1。
 */
function stripPartLabel(text: string): string {
  return text
    .replace(/^[(（]\s*\d+\s*[)）]\s*/, "")
    .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, "")
    .replace(/^第\s*\d+\s*[题问]\s*[:：]?\s*/, "");
}

/**
 * 提取数值：整数/小数、分数 a/b、带分数 c又a/b、百分数、纯中文数字。
 * 学生答案常带单位（"26 厘米"）——按数值比对，单位不参与。
 *
 * 「∠1=45°」这类先取等号右边：左边是标号，不是答案。
 */
export function parseNumeric(raw: string): number | null {
  let text = normalizeText(stripPartLabel(raw.trim()));
  // 等号右边才是答案（∠1=45° / x=4）
  const eq = text.lastIndexOf("=");
  if (eq >= 0 && eq < text.length - 1) text = text.slice(eq + 1);

  const cn = parseChineseNumber(text.replace(/[个只人袋条棵度分秒元米厘分平方]/g, ""));
  if (cn !== null) return cn;

  const percent = text.match(/(-?\d+(?:\.\d+)?)%/);
  if (percent) return Number(percent[1]) / 100;
  // 带分数要先于普通分数匹配，否则「2又1/2」会被读成 1/2
  const mixed = text.match(/(-?\d+)又(\d+)\/(\d+)/);
  if (mixed) {
    const den = Number(mixed[3]);
    if (den === 0) return null;
    const whole = Number(mixed[1]);
    const frac = Number(mixed[2]) / den;
    return whole < 0 ? whole - frac : whole + frac;
  }
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

// ---------------------------------------------------------------------------
// 限定词：方向反了就是错，不能因为数字对上就放过
// ---------------------------------------------------------------------------

/**
 * 互斥的限定词组。参考答案里出现了其中一个，孩子写了同组的另一个，
 * 那就是**确凿的错**——「少22人」与「多22人」数字都是 22，
 * 而那道题考的就是多还是少。
 *
 * 反过来，孩子只是**没写**这个词（写了「22」），不算确凿的错：
 * 转 pending 交给家长，别武断判错。
 */
const OPPOSITES: string[][] = [
  ["多", "少"],
  ["大", "小"],
  ["长", "短"],
  ["快", "慢"],
  ["高", "低"],
  ["增", "减"],
  ["升", "降"],
  ["盈", "亏"],
  ["奇", "偶"],
  ["东", "西"],
  ["南", "北"],
  ["左", "右"],
  ["前", "后"],
  ["上", "下"],
  ["甲", "乙", "丙", "丁"],
  ["是", "否"],
];

interface QualifierCheck {
  /** 孩子写了与参考答案互斥的词 */
  contradicted: boolean;
  /** 参考答案里的限定词，孩子一个都没提 */
  omitted: boolean;
}

function checkQualifiers(reference: string, student: string): QualifierCheck {
  const ref = normalizeText(reference);
  const stu = normalizeText(student);
  let contradicted = false;
  let omitted = false;
  for (const group of OPPOSITES) {
    const inRef = group.filter((w) => ref.includes(w));
    if (inRef.length !== 1) continue; // 参考答案里没有、或同组出现多个（如"比较大小"）：不判
    const expected = inRef[0]!;
    if (!stu.includes(expected)) {
      if (group.some((w) => w !== expected && stu.includes(w))) contradicted = true;
      else omitted = true;
    }
  }
  // 否定词单独看：「是」与「不是」只差一个字，字面比对分不出轻重
  if (/^不|^没|^无/.test(stu) !== /^不|^没|^无/.test(ref)) contradicted = true;
  return { contradicted, omitted };
}

// ---------------------------------------------------------------------------
// 多值答案：逐段比，段数必须相等
// ---------------------------------------------------------------------------

/** 分隔符：分号、逗号、顿号、"和"、"与" */
const SEPARATORS = /[;；,，、]|和|与/;

const hasDigit = (s: string) => /\d/.test(s);
const hasLetter = (s: string) => /[a-z]/i.test(s);

/**
 * 把答案切成几段。
 *
 * **只在每一段都含数字时才切**——这是关键的一道闸：
 * 「现在大米多，多6袋」切开会得到「现在大米多」和「多6袋」，
 * 于是孩子写「大米多6袋」（一段）就因为段数对不上被判错，而他是对的。
 * 那种答案是一句话，不是两个答案。
 */
export function splitAnswerParts(raw: string): string[] {
  const parts = stripEnumeration(splitLoose(raw));
  if (parts.length < 2) return [raw.trim()];
  return parts.every(hasDigit) ? parts : [raw.trim()];
}

/**
 * 去掉条目序号：「1亚洲、2大洋洲、3欧洲、4非洲、5美洲」里的 1~5 是编号，不是答案。
 *
 * 判据是**各段开头的数恰好是 1、2、3…**——这种连号只可能是编号。
 * 「44，20」「27;13;26」「10个,17个,12个」都不连号，原样保留。
 * 剥完变空的也不剥：答案本身就是「1，2，3」的题确实存在。
 */
function stripEnumeration(parts: string[]): string[] {
  if (parts.length < 2) return parts;
  const stripped: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const m = /^(\d+)\s*[.、．:：)）]?\s*(.+)$/.exec(parts[i]!);
    if (!m || Number(m[1]) !== i + 1 || !m[2]!.trim()) return parts;
    stripped.push(m[2]!.trim());
  }
  return stripped;
}

const pieces = (raw: string, sep: RegExp): string[] =>
  raw
    .split(sep)
    .map((p) => p.trim().replace(/[.．。]$/, "").trim())
    .filter(Boolean);

/** 小问编号：(1) （2） ①② */
const PART_LABEL = /[(（]\s*\d+\s*[)）]|[①②③④⑤⑥⑦⑧⑨⑩]/g;

/**
 * 按小问编号切：「( 1 ) 9021 . ( 2 ) 1909 .」是两个答案。
 *
 * 这一条必须在标点之前试——那串答案里一个逗号都没有，只有编号和空格；
 * 而按空格切会把「( 1 ) 9021」打成四段碎片，反倒判不出来。
 */
function splitByLabels(raw: string): string[] {
  const marks = [...raw.matchAll(PART_LABEL)];
  if (marks.length < 2) return [];
  const out: string[] = [];
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i]!.index!;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : raw.length;
    const chunk = raw.slice(start, end).trim().replace(/[.．。,，;；]$/, "").trim();
    if (chunk) out.push(chunk);
  }
  return out.length >= 2 ? out : [];
}

/**
 * 不带数字要求地切开。**只在已知参考答案是多值时**才用它切学生的答案。
 *
 * 为什么要分两套：参考答案「1亚洲、2大洋洲、…」是五段（每段带序号），
 * 而孩子多半写「亚洲、大洋洲、…」——没有数字。用严格规则去切他的答案会切不开，
 * 段数 1≠5，于是一个全对的答案被判错。既然参考答案已经告诉我们该有几段，
 * 学生那边就不必再自己判断了。
 *
 * `expect` 是参考答案的段数：只有按标点切不出那么多段时，才退而用空格再切一次
 * （孩子写「44 20」）。空格不能当默认分隔符——它会把带编号的答案打成碎片。
 */
function splitLoose(raw: string, expect?: number): string[] {
  const byLabel = splitByLabels(raw);
  if (byLabel.length >= 2) return byLabel;
  const byPunct = pieces(raw, SEPARATORS);
  if (byPunct.length >= 2 || !expect || expect < 2) return byPunct;
  return pieces(raw, /[;；,，、\s]|和|与/);
}

/** 集合型答案（乙和丁 = 丁和乙）：切开、排序、比 */
function sameTokenSet(a: string, b: string): boolean {
  const tokens = (s: string) =>
    s
      .split(SEPARATORS)
      .map((t) => normalizeText(t))
      .filter(Boolean)
      .sort();
  const ta = tokens(a);
  const tb = tokens(b);
  return ta.length > 1 && ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

// ---------------------------------------------------------------------------
// 表达式
// ---------------------------------------------------------------------------

/** 表达式等价：mathjs 解析 + 多点采样求值一致（防「化简形式不同判错」） */
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
    .replace(/[个只人袋条棵元米]/g, "")
    .trim();
  const eq = text.split("=");
  return (eq.length === 2 ? eq[1]! : text).trim();
}

// ---------------------------------------------------------------------------
// 答案不唯一
// ---------------------------------------------------------------------------

/**
 * 参考答案里用「或」列出的几种解法。
 *
 * 巧填算符那一讲整讲都是这样的题，讲义原文就写着「答案不唯一」，
 * 还列着「方法一…方法五」。此前把整串当一个答案比，结果荒唐到
 * **参考答案自己列出的第一种解法都判错**（parseNumeric 取最后一个等号右边，
 * 于是只有答第二种的才对）。
 *
 * 「大于或等于」这类词里的「或」不算分隔——后面跟着「等」的排除掉。
 */
export function answerAlternatives(raw: string): string[] {
  const parts = raw
    .split(/或(?:者)?(?!等)/)
    .map((p) => p.trim().replace(/^[,，、;；]/, "").trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [];
}

/**
 * 等式类题目：**按条件验算，不按答案比对**。
 *
 * 「在这些数之间填运算符使等式成立」的正确性不在于写出来长什么样，
 * 而在于满不满足条件：算出来对不对、用的是不是题目给的那几个数字。
 * 拿一个固定字符串去比，方向本身就错了——孩子换一种同样正确的填法就被判错。
 *
 * 三条一起成立才算对：
 * ① 孩子写的等式**自己成立**（左边算出来等于右边）
 * ② 得数与参考答案一致（题目要求凑出的那个数）
 * ③ 用到的数字与参考答案是同一组（按数位比：1、2 既可以当 12 也可以分开用，
 *    所以比的是数字而不是数）
 */
const equationSides = (text: string) => {
  const t = normalizeText(text).replace(/[（]/g, "(").replace(/[）]/g, ")");
  const at = t.lastIndexOf("=");
  if (at <= 0 || at >= t.length - 1) return null;
  return { left: t.slice(0, at), right: t.slice(at + 1) };
};

const evaluateArithmetic = (expr: string): number | null => {
  try {
    const v = math.evaluate(expr);
    return typeof v === "number" && isFinite(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * 这是不是一个**算术等式**（两边都算得出数）。
 *
 * 「∠1=45°」「x=4」都带等号却不是——左边是标号或未知数，算不出来。
 * 分清楚很要紧：算术等式要按条件严格验算（错了就是错了），
 * 而那两种得走普通比对，否则「∠1=45°」和「∠1=45度」会被判错。
 */
export function isArithmeticEquation(text: string): boolean {
  const sides = equationSides(text);
  if (!sides) return false;
  return evaluateArithmetic(sides.left) !== null && evaluateArithmetic(sides.right) !== null;
}

export function equationSatisfiesCondition(reference: string, student: string): boolean {
  const sides = (text: string) => {
    const t = normalizeText(text).replace(/[（]/g, "(").replace(/[）]/g, ")");
    const at = t.lastIndexOf("=");
    if (at <= 0 || at >= t.length - 1) return null;
    return { left: t.slice(0, at), right: t.slice(at + 1) };
  };
  const evaluate = (expr: string): number | null => {
    try {
      const v = math.evaluate(expr);
      return typeof v === "number" && isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  const digits = (expr: string) => (expr.match(/\d/g) ?? []).sort().join("");

  const ref = sides(reference);
  const stu = sides(student);
  if (!ref || !stu) return false;

  const stuLeft = evaluate(stu.left);
  const stuRight = evaluate(stu.right);
  const refRight = evaluate(ref.right);
  if (stuLeft === null || stuRight === null || refRight === null) return false;

  if (!numbersClose(stuLeft, stuRight)) return false; // ① 等式得自己成立
  if (!numbersClose(stuRight, refRight)) return false; // ② 得数要一致
  return digits(stu.left) === digits(ref.left); // ③ 用的是同一组数字
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

const CORRECT = (method: GradeResult["method"]): GradeResult => ({ correct: true, method });
const WRONG = (method: GradeResult["method"]): GradeResult => ({ correct: false, method });
const PENDING: GradeResult = { correct: false, method: "pending" };

/** 判一段（也就是单值答案）。多值答案由 grade 拆开后逐段调用它 */
function gradeSingle(reference: string, student: string): GradeResult {
  const ref = reference.trim();
  const stu = student.trim();
  if (!stu) return WRONG("string");
  if (normalizeText(ref) === normalizeText(stu)) return CORRECT("string");

  const qualifiers = checkQualifiers(ref, stu);
  if (qualifiers.contradicted) return WRONG("string");

  // 代数式：含字母就先按等价变形比（2x+2 与 2(x+1) 是同一个答案）
  if (hasLetter(ref) || hasLetter(stu)) {
    if (expressionsEquivalent(ref, stu)) return CORRECT("expression");
  }

  const expected = parseNumeric(ref);
  const got = parseNumeric(stu);
  if (expected !== null && got !== null) {
    if (!numbersClose(expected, got)) return WRONG("numeric");
    // 数字对上了，但参考答案里还有个限定词孩子没写——判不准，交给家长
    return qualifiers.omitted ? PENDING : CORRECT("numeric");
  }

  // 纯文字：顺序无关的集合（乙和丁 = 丁和乙）算对
  if (sameTokenSet(ref, stu)) return CORRECT("string");
  // 剩下的都判不准。**不判错**——判错一次，孩子会开始怀疑自己
  return PENDING;
}

/**
 * 由答案本身推出该用哪种判卷方式。
 *
 * 模型标的 answerType 不可信：实测题库里 13 道纯文字题被标成 expression、
 * 2 道纯数值题被标成 steps。后者代价很实在——steps 的题不判对错、
 * 不计掌握度、也不进变式题池，孩子做对了只会看到"已交给家长确认"。
 * 根因是抽取提示词写的是"**单个**数值答案用 numeric"，模型看到两个数只能塞进 steps。
 *
 * 判卷本身已经不看这个字段了（策略在 grade 里现推），但它还影响变式选题
 * 与界面展示，所以入库时按这里的推导归一，别把模型的错标留在库里。
 */
export function deriveAnswerType(answer: string): Question["answerType"] {
  // 先把条目序号剥掉再看：「1亚洲、2大洋洲…」剥完一个数字都不剩，它是文字答案，
  // 不剥的话那几个序号会让它冒充数值题
  const cleaned = stripEnumeration(splitLoose(answer)).join(",");
  if (hasDigit(cleaned) && !hasLetter(cleaned)) return "numeric";
  // 含字母：逐段试解析（「(a-25)元；12a+25b元」整串解析不了，分开就行）
  if (hasLetter(cleaned)) {
    const parts = splitAnswerParts(answer);
    const parsable = parts.every((part) => {
      try {
        math.parse(normalizeExpressionInput(part));
        return true;
      } catch {
        return false;
      }
    });
    if (parsable) return "expression";
  }
  // 剩下的是文字答案：程序未必判得了，交给 grade 的 pending 兜底
  return "steps";
}

/**
 * 判卷。answerType 只作参考、不作依据（题库里的标注实测有 15 道是错的），
 * 策略由答案本身推导。
 */
export function grade(
  question: Pick<Question, "answer" | "answerType"> & { answerUnique?: boolean },
  studentAnswer: string,
): GradeResult {
  const student = studentAnswer.trim();
  if (!student) return WRONG("string");

  /**
   * 答案不唯一的题：参考答案只是**其中一种**解法。
   * 逐个分支试，命中任一即对；一个都没命中也不判错——
   * 孩子完全可能写出参考答案没列的那一种。
   */
  const alternatives = answerAlternatives(question.answer);
  if (alternatives.length >= 2) {
    const tried = alternatives.map((alt) =>
      grade({ ...question, answer: alt, answerUnique: true }, student),
    );
    const hit = tried.find((r) => r.correct);
    if (hit) return hit;
    // 每一条都是按条件验算否掉的（算术等式），那就是确凿的错：
    // 孩子的算式要么自己不成立、要么得数不对、要么用了别的数字。
    if (tried.every((r) => r.method === "expression")) return WRONG("expression");
    // 否则判不准——参考答案只列了几种，孩子完全可能写出没列出的那一种
    return PENDING;
  }

  /**
   * 算术等式：**按条件验算，不按答案比对**。
   * 换一种同样正确的填法算对；不满足条件就是错——不能落回"比等号右边"，
   * 那样「5+5=10」会因为得数是 10 而判对，可题目给的数字是 1、2、3、4。
   */
  if (isArithmeticEquation(question.answer) && student.includes("=")) {
    return equationSatisfiesCondition(question.answer, student)
      ? CORRECT("expression")
      : WRONG("expression");
  }

  const refParts = splitAnswerParts(question.answer);
  if (refParts.length >= 2) {
    // 参考答案已经告诉我们该有几段，学生那边就按同样的分隔符切开，
    // 不再要求每段都含数字（孩子写答案时常常省掉序号）
    const stuParts = splitLoose(student, refParts.length);
    // 段数对不上 = 少答了或多答了。这一条修掉了"参考答案 44，20 而孩子只写 44 判成对"
    if (stuParts.length !== refParts.length) return WRONG("string");
    const results = refParts.map((r, i) => gradeSingle(r, stuParts[i]!));
    if (results.some((r) => r.method === "pending")) return PENDING;
    return results.every((r) => r.correct) ? CORRECT("numeric") : WRONG("numeric");
  }

  const result = gradeSingle(question.answer, student);
  // 题目本身答案就不唯一时，对不上不代表孩子错了——交给家长看
  if (!result.correct && result.method !== "pending" && question.answerUnique === false) {
    return PENDING;
  }
  return result;
}
