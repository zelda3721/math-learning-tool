/**
 * 白名单表达式求值：手写 tokenizer + 递归下降 parser，编译成闭包。
 *
 * 纪律（镜像引擎侧「绝不执行任意代码」）：
 * - 绝不使用 eval / new Function / Function 构造器；
 * - 不认识的记号一律 `ok:false` 并说明原因 —— 绝不静默返回一个"能画出线"的假函数；
 * - 定义域外（除零 / log 非正 / sqrt 负数 / tan 极点 / 溢出）返回 `null`，
 *   而不是让 NaN 蔓延成一条看似合理的曲线。
 *
 * 文法（优先级由低到高）：
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/') unary)*
 *   unary  := ('-' | '+') unary | power
 *   power  := atom (('^' | '**') unary)?        // 右结合；右侧走 unary 以支持 2^-x
 *   atom   := number | constant | variable
 *           | ident '(' expr (',' expr)* ')'
 *           | '(' expr ')'
 *
 * 因此 `-x^2` = -(x^2)，`2^3^2` = 2^(3^2) = 512，与 SymPy / 数学惯例一致。
 */

/** 单点求值：返回 null 表示该点无定义（极点 / 定义域外 / 溢出） */
export type EvalFn = (x: number) => number | null;

/** compileExpression 的结果：成功给闭包，失败给人话原因 */
export type CompileResult = { ok: true; fn: EvalFn } | { ok: false; error: string };

/* ------------------------------------------------------------------ *
 * 词法
 * ------------------------------------------------------------------ */

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "ident"; name: string; pos: number }
  | { kind: "op"; op: string; pos: number };

const OP_CHARS = new Set(["+", "-", "*", "/", "^", "(", ")", ","]);

class ExprError extends Error {}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdentStart = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      while (i < src.length && isDigit(src[i] as string)) i += 1;
      if (src[i] === ".") {
        i += 1;
        while (i < src.length && isDigit(src[i] as string)) i += 1;
      }
      // 科学计数法：只有 e/E 后面确实跟着数字时才算指数部分，
      // 否则 `2e` 里的 e 应当当作常数 e（由 parser 报"缺少运算符"）。
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j += 1;
        if (isDigit(src[j] ?? "")) {
          j += 1;
          while (j < src.length && isDigit(src[j] as string)) j += 1;
          i = j;
        }
      }
      const text = src.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ExprError(`无法解析的数字 "${text}"（位置 ${start}）`);
      }
      out.push({ kind: "num", value, pos: start });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i] as string)) i += 1;
      out.push({ kind: "ident", name: src.slice(start, i), pos: start });
      continue;
    }
    if (c === "*" && src[i + 1] === "*") {
      out.push({ kind: "op", op: "^", pos: i });
      i += 2;
      continue;
    }
    if (OP_CHARS.has(c)) {
      out.push({ kind: "op", op: c, pos: i });
      i += 1;
      continue;
    }
    throw new ExprError(`无法识别的字符 "${c}"（位置 ${i}）`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 白名单：常量与函数
 * ------------------------------------------------------------------ */

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
};

/** 定义域外统一返回 null；返回 number 的会再过一道有限性检查 */
interface FuncDef {
  minArgs: number;
  maxArgs: number;
  apply: (args: number[]) => number | null;
}

const positiveLog = (v: number): number | null => (v > 0 ? Math.log(v) : null);

const FUNCTIONS: Record<string, FuncDef> = {
  sin: { minArgs: 1, maxArgs: 1, apply: (a) => Math.sin(a[0] as number) },
  cos: { minArgs: 1, maxArgs: 1, apply: (a) => Math.cos(a[0] as number) },
  tan: {
    minArgs: 1,
    maxArgs: 1,
    apply: (a) => {
      const x = a[0] as number;
      // cos(x) 在极点附近会落到机器精度级别；此时 tan 已无意义，诚实地报无定义。
      return Math.abs(Math.cos(x)) < Number.EPSILON ? null : Math.tan(x);
    },
  },
  asin: {
    minArgs: 1,
    maxArgs: 1,
    apply: (a) => {
      const x = a[0] as number;
      return x < -1 || x > 1 ? null : Math.asin(x);
    },
  },
  acos: {
    minArgs: 1,
    maxArgs: 1,
    apply: (a) => {
      const x = a[0] as number;
      return x < -1 || x > 1 ? null : Math.acos(x);
    },
  },
  atan: { minArgs: 1, maxArgs: 1, apply: (a) => Math.atan(a[0] as number) },
  sinh: { minArgs: 1, maxArgs: 1, apply: (a) => Math.sinh(a[0] as number) },
  cosh: { minArgs: 1, maxArgs: 1, apply: (a) => Math.cosh(a[0] as number) },
  tanh: { minArgs: 1, maxArgs: 1, apply: (a) => Math.tanh(a[0] as number) },
  exp: { minArgs: 1, maxArgs: 1, apply: (a) => Math.exp(a[0] as number) },
  // SymPy 的 log(x) 是自然对数；log(x, b) 是以 b 为底。
  log: {
    minArgs: 1,
    maxArgs: 2,
    apply: (a) => {
      const v = positiveLog(a[0] as number);
      if (v === null) return null;
      if (a.length === 1) return v;
      const base = a[1] as number;
      if (base <= 0 || base === 1) return null;
      const lb = Math.log(base);
      return lb === 0 ? null : v / lb;
    },
  },
  ln: { minArgs: 1, maxArgs: 1, apply: (a) => positiveLog(a[0] as number) },
  lg: {
    minArgs: 1,
    maxArgs: 1,
    apply: (a) => {
      const x = a[0] as number;
      return x > 0 ? Math.log10(x) : null;
    },
  },
  sqrt: {
    minArgs: 1,
    maxArgs: 1,
    apply: (a) => {
      const x = a[0] as number;
      return x < 0 ? null : Math.sqrt(x);
    },
  },
  abs: { minArgs: 1, maxArgs: 1, apply: (a) => Math.abs(a[0] as number) },
  sign: { minArgs: 1, maxArgs: 1, apply: (a) => Math.sign(a[0] as number) },
  floor: { minArgs: 1, maxArgs: 1, apply: (a) => Math.floor(a[0] as number) },
  ceil: { minArgs: 1, maxArgs: 1, apply: (a) => Math.ceil(a[0] as number) },
  min: { minArgs: 1, maxArgs: 16, apply: (a) => Math.min(...a) },
  max: { minArgs: 1, maxArgs: 16, apply: (a) => Math.max(...a) },
  pow: { minArgs: 2, maxArgs: 2, apply: (a) => Math.pow(a[0] as number, a[1] as number) },
};

/** SymPy 会打印 Abs/Max/Min/E/Pi 这类大写写法，按小写查一次白名单（不放宽白名单本身） */
const canonical = (name: string): string => name.toLowerCase();

/* ------------------------------------------------------------------ *
 * 语法 + 编译
 * ------------------------------------------------------------------ */

/** 编译后的节点：吃 x 吐 number|null */
type Node = EvalFn;

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);

function constNode(value: number): Node {
  const v = finite(value);
  return () => v;
}

function binaryNode(a: Node, b: Node, f: (p: number, q: number) => number | null): Node {
  return (x) => {
    const va = a(x);
    if (va === null) return null;
    const vb = b(x);
    if (vb === null) return null;
    const r = f(va, vb);
    return r === null ? null : finite(r);
  };
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(
    tokens: Token[],
    private readonly variable: string,
  ) {
    this.tokens = tokens;
  }

  parse(): Node {
    const node = this.parseExpr();
    const rest = this.peek();
    if (rest) {
      throw new ExprError(`表达式在位置 ${rest.pos} 处有多余记号 "${this.describe(rest)}"`);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private describe(tok: Token): string {
    if (tok.kind === "num") return String(tok.value);
    if (tok.kind === "ident") return tok.name;
    return tok.op;
  }

  private eatOp(op: string): boolean {
    const tok = this.peek();
    if (tok && tok.kind === "op" && tok.op === op) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectOp(op: string, what: string): void {
    if (!this.eatOp(op)) {
      const tok = this.peek();
      const where = tok ? `位置 ${tok.pos} 处的 "${this.describe(tok)}"` : "表达式末尾";
      throw new ExprError(`${what}：期望 "${op}"，实际是${where}`);
    }
  }

  private parseExpr(): Node {
    let left = this.parseTerm();
    for (;;) {
      if (this.eatOp("+")) left = binaryNode(left, this.parseTerm(), (p, q) => p + q);
      else if (this.eatOp("-")) left = binaryNode(left, this.parseTerm(), (p, q) => p - q);
      else return left;
    }
  }

  private parseTerm(): Node {
    let left = this.parseUnary();
    for (;;) {
      if (this.eatOp("*")) left = binaryNode(left, this.parseUnary(), (p, q) => p * q);
      else if (this.eatOp("/")) {
        left = binaryNode(left, this.parseUnary(), (p, q) => (q === 0 ? null : p / q));
      } else return left;
    }
  }

  private parseUnary(): Node {
    if (this.eatOp("-")) {
      const inner = this.parseUnary();
      return (x) => {
        const v = inner(x);
        return v === null ? null : finite(-v);
      };
    }
    if (this.eatOp("+")) return this.parseUnary();
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parseAtom();
    if (this.eatOp("^")) {
      // 右结合，且指数侧允许一元负号：2^-x
      const exponent = this.parseUnary();
      return binaryNode(base, exponent, (p, q) => Math.pow(p, q));
    }
    return base;
  }

  private parseAtom(): Node {
    const tok = this.peek();
    if (!tok) throw new ExprError("表达式在此处意外结束（缺少操作数）");

    if (tok.kind === "num") {
      this.index += 1;
      return constNode(tok.value);
    }

    if (tok.kind === "op") {
      if (tok.op === "(") {
        this.index += 1;
        const inner = this.parseExpr();
        this.expectOp(")", "括号未闭合");
        return inner;
      }
      throw new ExprError(`位置 ${tok.pos} 处不该出现 "${tok.op}"`);
    }

    // 标识符：函数调用 / 变量 / 常量
    this.index += 1;
    const name = tok.name;
    const key = canonical(name);
    const isCall = (() => {
      const next = this.peek();
      return !!next && next.kind === "op" && next.op === "(";
    })();

    if (isCall) {
      const def = FUNCTIONS[key];
      if (!def) throw new ExprError(`不支持的函数 "${name}"（位置 ${tok.pos}）`);
      this.expectOp("(", `函数 ${name} 缺少左括号`);
      const args: Node[] = [];
      if (!this.eatOp(")")) {
        for (;;) {
          args.push(this.parseExpr());
          if (this.eatOp(",")) continue;
          this.expectOp(")", `函数 ${name} 的括号未闭合`);
          break;
        }
      }
      if (args.length < def.minArgs || args.length > def.maxArgs) {
        const want =
          def.minArgs === def.maxArgs ? `${def.minArgs}` : `${def.minArgs}~${def.maxArgs}`;
        throw new ExprError(`函数 ${name} 需要 ${want} 个参数，实际给了 ${args.length} 个`);
      }
      return (x) => {
        const values: number[] = [];
        for (const arg of args) {
          const v = arg(x);
          if (v === null) return null;
          values.push(v);
        }
        const r = def.apply(values);
        return r === null ? null : finite(r);
      };
    }

    // 变量优先于常量：变量叫 e 时 e 就是变量，不是自然对数底。
    if (name === this.variable) return (x) => finite(x);

    const constant = CONSTANTS[key];
    if (constant !== undefined) return constNode(constant);

    if (FUNCTIONS[key]) {
      throw new ExprError(`函数 ${name} 缺少参数（位置 ${tok.pos}）`);
    }
    throw new ExprError(
      `未知符号 "${name}"（位置 ${tok.pos}）：自变量是 "${this.variable}"，不认识的量无法求值`,
    );
  }
}

/**
 * 把表达式字符串编译成可求值的闭包。
 *
 * @param expr     表达式（SymPy 风味：`**` 与 `^` 都当作幂）
 * @param variable 自变量名（空串按 "x" 处理）
 */
export function compileExpression(expr: string, variable: string): CompileResult {
  if (typeof expr !== "string" || expr.trim().length === 0) {
    return { ok: false, error: "表达式为空" };
  }
  const varName = typeof variable === "string" && variable.trim().length > 0 ? variable.trim() : "x";
  if (!isIdentStart(varName[0] as string) || ![...varName].every(isIdentPart)) {
    return { ok: false, error: `自变量名 "${variable}" 不是合法标识符` };
  }
  try {
    const tokens = tokenize(expr);
    if (tokens.length === 0) return { ok: false, error: "表达式为空" };
    const node = new Parser(tokens, varName).parse();
    const fn: EvalFn = (x) => {
      if (!Number.isFinite(x)) return null;
      return node(x);
    };
    return { ok: true, fn };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** 暴露白名单，便于上层给出"支持哪些写法"的提示 */
export const SUPPORTED_FUNCTIONS: readonly string[] = Object.keys(FUNCTIONS);
export const SUPPORTED_CONSTANTS: readonly string[] = Object.keys(CONSTANTS);
