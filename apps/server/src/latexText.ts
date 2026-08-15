/**
 * 把题干里的 LaTeX 转成可读的普通文字——**给讲解引擎用**。
 *
 * 题库/抽取存的题干带 `$...$`（练习页有 KaTeX，渲染得很好），
 * 但讲解引擎的产物没有这个待遇：模型直写的讲解页跑在 sandbox iframe 里
 * （CSP 禁一切外部资源，塞不进 KaTeX），SceneSpec 的台词画在 canvas 上。
 * `$AE=ED$` 原样送过去，孩子看到的就是原样的美元符号。
 *
 * 所以送引擎前在网关把 LaTeX 落成普通文字：`$AE=ED$`→`AE=ED`、
 * `\frac{1}{2}`→`1/2`、`\times`→`×`。**只在引擎载荷上做**，
 * 题库里存的原文一个字不动。
 *
 * 纪律：转换必须保义。认得的写法才转，认不得的命令原样留下——
 * 剥掉定界符后的 `\foo` 再难看也比转错一个数学意思强。
 */

/** 无参数命令 → Unicode 符号（小学到初中够用的一套，与 MathText 的白名单同源） */
const SYMBOLS: [RegExp, string][] = [
  [/\\times\b/g, "×"],
  [/\\div\b/g, "÷"],
  [/\\cdot\b/g, "·"],
  [/\\pm\b/g, "±"],
  [/\\mp\b/g, "∓"],
  [/\\leq?\b/g, "≤"],
  [/\\geq?\b/g, "≥"],
  [/\\neq?\b/g, "≠"],
  [/\\approx\b/g, "≈"],
  // 前缀型记号吞掉后随空格（LaTeX 里命令后的空格只是分隔符）：\angle ABC → ∠ABC
  [/\\angle\s*/g, "∠"],
  [/\\triangle\s*/g, "△"],
  [/\\perp\b/g, "⊥"],
  [/\\parallel\b/g, "∥"],
  [/\\cong\b/g, "≅"],
  [/\\sim\b/g, "∽"],
  [/\\pi\b/g, "π"],
  [/\\alpha\b/g, "α"],
  [/\\beta\b/g, "β"],
  [/\\gamma\b/g, "γ"],
  [/\\theta\b/g, "θ"],
  [/\\infty\b/g, "∞"],
  [/\\degree\b/g, "°"],
  [/\^\{?\\circ\}?/g, "°"],
  [/\\%/g, "%"],
  [/\\(?:ldots|cdots|dots)\b/g, "…"],
  // 排版间距没有语义，落成一个空格
  [/\\(?:quad|qquad)\b/g, " "],
  [/\\[,;!:]/g, " "],
  // \left( \right) 只是括号的排版修饰
  [/\\left\b/g, ""],
  [/\\right\b/g, ""],
];

/** 一个花括号组的内容（i 指向 `{`）；括号不配对时返回 null，让调用方放弃这一处 */
function braceGroup(text: string, i: number): { content: string; end: number } | null {
  if (text[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === "{") depth += 1;
    else if (text[j] === "}") {
      depth -= 1;
      if (depth === 0) return { content: text.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

/** 简单到不需要括号保护的内容：纯数字、纯字母、或单个符号 */
const isAtom = (s: string) => /^[0-9]+(?:\.[0-9]+)?$|^[a-zA-Z]$|^.$/.test(s);

/**
 * 逐个展开带花括号参数的命令。从内往外：每一轮只处理参数里不再含命令的那些，
 * 循环直到没有变化（嵌套层数有限，实际两三轮就收敛）。
 */
function expandBraced(text: string): string {
  for (let round = 0; round < 8; round += 1) {
    let changed = false;
    let out = "";
    let i = 0;
    while (i < text.length) {
      const m = /^\\([dtc]?frac|sqrt|overline|underline|bar|vec|text|mathrm)\b/.exec(text.slice(i));
      if (!m) {
        out += text[i];
        i += 1;
        continue;
      }
      const name = m[1]!;
      let j = i + m[0].length;
      const first = braceGroup(text, j);
      if (!first) {
        // 没跟参数（或括号残缺）：原样保留，别猜
        out += m[0];
        i = j;
        continue;
      }
      if (name.endsWith("frac")) {
        const second = braceGroup(text, first.end);
        if (!second) {
          out += m[0];
          i = j;
          continue;
        }
        const a = isAtom(first.content) ? first.content : `(${first.content})`;
        const b = isAtom(second.content) ? second.content : `(${second.content})`;
        // 带分数：`50\frac{1}{4}` 直接拼成 `501/4` 会变成另一个数——中间垫个空格
        const sep = /[0-9]$/.test(out) ? " " : "";
        out += `${sep}${a}/${b}`;
        i = second.end;
      } else if (name === "sqrt") {
        out += isAtom(first.content) ? `√${first.content}` : `√(${first.content})`;
        i = first.end;
      } else {
        // overline/underline/bar/vec 表示线段/向量记号，text/mathrm 是排版——内容本身就是意思
        out += first.content;
        i = first.end;
      }
      changed = true;
    }
    text = out;
    if (!changed) break;
  }
  return text;
}

export function latexToPlainText(text: string): string {
  let out = text;
  for (const [re, to] of SYMBOLS) out = out.replace(re, to);
  out = expandBraced(out);
  // 常见上标：平方/立方转 Unicode，其余保留 ^ 的写法（^{10} → ^10）。
  // 先整体处理 ^{...} 再处理裸 ^2——顺序反了会把 ^{23} 错拆成 ²3
  out = out.replace(/\^\{(\d+)\}/g, (_all, d: string) =>
    d === "2" ? "²" : d === "3" ? "³" : `^${d}`,
  );
  out = out.replace(/\^2\b/g, "²").replace(/\^3\b/g, "³");
  // 剥掉数学定界符：$...$、$$...$$、\( \)、\[ \]
  out = out.replace(/\\[()[\]]/g, "").replace(/\$+/g, "");
  // 转换会留下多余空格（间距命令、带分数垫的空格挨着标点等），收拢一下
  return out.replace(/ {2,}/g, " ").trim();
}
