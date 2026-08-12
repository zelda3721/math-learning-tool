/**
 * 分层抽取：版面 → 逐题内容 → 配图。
 *
 * 此前是一页一次调用，那一次要模型同时干五件事：切题、读内容、判属性、
 * 挂知识点、写图形规格。实机上的每个失败都能追到这里——输出必然长（截断）、
 * 图形规格是埋在"顺便再干四件事"里的活（字段名飘移）、每页独立（跨页接不上）。
 * 提高 maxTokens、改 JSONL，都只是在给一个过载的调用打补丁。
 *
 * 现在拆开：
 * ① 版面：只回答"这一页有几道题、各在哪、有没有图"。输出极短，几乎不会截断。
 * ② 内容：按版面给的框把题裁成小图，一题一次。图小、任务单一，输出也短。
 * ③ 配图：只对标了有图的题单独要一次规格。写图形规格是独立的活，就该独立做。
 *
 * 每一趟都能单独降级：版面拿不到就整页走老路；框不可用就用整页图跑第二趟；
 * 配图那趟失败只丢图不丢题。
 */
import type { EducationLevel } from "@mathtutor/schema";

/** 版面里的一道题。box 用 0~1 的相对坐标，与渲染分辨率无关 */
export interface LayoutItem {
  index: number;
  label: string;
  preview: string;
  /** [x0, y0, x1, y1]，均为 0~1；给不出可用框时为 undefined */
  box?: [number, number, number, number];
  hasFigure: boolean;
  /** 配图本身的范围。裁出来存成原题原图 */
  figureBox?: [number, number, number, number];
  /**
   * 【解析】灰框里那张图的范围——教师版常在解析里再画一张：
   * 割补怎么割、阴影怎么挪、辅助线画在哪。
   * 它**不是题干的一部分**，孩子做题时不能看见（那张图往往就是解法本身）。
   */
  analysisFigureBox?: [number, number, number, number];
  /**
   * 【答案】灰框的上边缘（0~1）。**题干与解析的分界线。**
   *
   * 一度想拿"模型框题的下边界"当分界——那是改提示词之前的观测。
   * 后来为了不丢答案，明确要求它"一直框到下一道题之前"，
   * 那个框于是包含了整个解析区，分界线随之失效。
   * 拿过时的测量当依据是危险的：判据看着有理，实际早就不成立了。
   *
   * 所以改成直接问：灰框那条边模型看得一清二楚，答一个数即可。
   */
  answerTop?: number;
  /** 这一页开头是不是上一页某题的续文 */
  continued: boolean;
  /**
   * 续文接的是哪一半：题干还没写完，还是上一页那道题的【答案】【解析】。
   *
   * 这个区分不能靠 answerTop 顶替。实测第5讲 p5：整个页首是上一页那道题
   * 解析的后半截（推演表 + 结论 + 【标注】），【答案】标签在上一页，
   * 模型只能指着【标注】说"答案框从 0.28 开始"，于是 0.05~0.27 的推演表
   * 被判成"答案框之上"= 题干图——而那张表最后一行就是答案。
   *
   * 缺省当 answer：判不准时少一张题干图看得见，多给一张答案表看不见。
   */
  continuedKind?: "stem" | "answer";
}

/**
 * 这一条只有题号、没有题干——**下一页那道题的头**。
 *
 * 讲义常把题号排在页脚、正文翻到下一页：版面那趟于是给出
 * `{"label":"练习9","preview":"练习9","box":[0.12,0.89,0.89,0.91]}`——
 * 一条 2% 高的窄带。此前把它当成一道题去抽，抽出来的是同页别的题
 * （框太窄判废、退回整页），被查重挡掉；而下一页的正文因为标着 continued
 * 被并进了上一道题。第10讲的练习7、练习9 就是这么一起丢的。
 *
 * 判据只看内容：preview 与 label 一模一样，说明这条里除了题号什么都没有。
 */
export function isDanglingLabel(item: LayoutItem): boolean {
  const label = item.label.trim();
  if (!label) return false; // 没有题号就没有东西可以传给下一页
  /**
   * 判据是**位置**，不是 preview 的字面。
   *
   * 一度只看「preview 与 label 相同」，结果第10讲的练习7 还是漏了：
   * 模型给它的 preview 是旁边的章节标题「二、转动数学大脑」。
   * 改看框高又不稳——同一页跑两次，框时窄时宽。
   * 稳的是这两件事合起来：**在页面最下方**，而且**开头这几个字不像题干**。
   *
   * 判错的代价也压到了最低：这一条的文字会随题号一起带到下一页去拼
   * （见前端的 pendingPreview），所以哪怕误判，也只是多带几个字，不会丢内容。
   */
  // 在页面最下方（拿不到框的那种更是——normalizeBox 把窄条判废了）
  const atBottom = !item.box || item.box[1] >= 0.7;
  if (!atBottom) return false;
  const preview = item.preview.trim();
  /**
   * 只认两种**不会误伤真题**的形态：
   * ① 开头就是题号本身（`preview === label`）——那条里除了题号什么都没有
   * ② 开头是章节标题（「二、转动数学大脑」）——模型看到题号旁边的大标题就写了它
   *
   * 一度放宽成"开头不足 12 字就算"，那是错的：真题的开头完全可能很短
   * （「如图，求阴影面积」正好 9 字），而被判成光杆的那一条会被整条丢掉。
   * 宁可漏认几个光杆题号（还有补漏那道网兜着），也不能误伤真题。
   */
  return preview === "" || preview === label || /^[一二三四五六七八九十]+\s*[、.．]/.test(preview);
}

export interface FigureSplit {
  /** 题干配图：孩子做题时看的那张 */
  stemFigureBox?: [number, number, number, number];
  /** 解析配图：只在讲解时用 */
  analysisFigureBox?: [number, number, number, number];
}

/**
 * 把模型给的两个框判成「题干图」和「解析图」。
 *
 * **结构说了算，模型的标注只是参考。** 模型分得清灰框，但它也会看错；
 * 而"这张图在不在题干框之内"是几何事实，量一下就知道。
 *
 * 拿不准时一律当解析图——两种错的代价差得远：
 * 把解析图当题干图给了孩子，他一打开就看见解法，而且**从结果上看不出来**；
 * 把题干图误判成解析图，只是这道几何题少了张图，谁都会立刻发现。
 */
export function classifyFigures(item: LayoutItem): FigureSplit {
  const { figureBox, analysisFigureBox, answerTop } = item;
  const out: FigureSplit = {};

  /**
   * 续文接的是上一题的答案/解析时，**这一整块里没有题干**——题干在上一页。
   * 所以它带的图一律是解析图，不必再看 answerTop（在续页上那个数没有意义：
   * 【答案】标签留在了上一页，模型只能指着【标注】之类的东西作答）。
   */
  if (item.continued && item.continuedKind !== "stem") {
    const box = figureBox ?? analysisFigureBox;
    return box ? { analysisFigureBox: box } : {};
  }

  // 知道灰框在哪时，位置说了算——模型偶尔会把两张图标反，而"图在灰框上面还是
  // 下面"是几何事实。不知道时（学生版没有答案框，或模型没答）就信它的标注：
  // 那种材料里本来就不存在解析图。
  // answerTop === 0 时下面那个比较恒为假，于是所有图都算解法图——
  // 这正是"续页开头全是上一页的答案"该有的结果
  const decideByPosition = typeof answerTop === "number";
  const aboveAnswer = (box?: [number, number, number, number]) =>
    box !== undefined && box[1] < answerTop!;

  if (decideByPosition) {
    for (const box of [figureBox, analysisFigureBox]) {
      if (!box) continue;
      if (aboveAnswer(box)) out.stemFigureBox ??= box;
      else out.analysisFigureBox ??= box;
    }
  } else {
    out.stemFigureBox = figureBox;
    out.analysisFigureBox = analysisFigureBox;
  }
  return out;
}

export const LAYOUT_PROMPT = `你在做**版面切分**，不要读题、不要解题、不要写解析。

看这一页，回答它有哪几道题。**一行一道题**，每行一个 JSON 对象，不要数组、不要代码围栏：
{"index":1,"label":"练习1","preview":"题干开头十来个字","box":[0.08,0.12,0.95,0.30],"hasFigure":true,"figureBox":[0.55,0.15,0.92,0.28],"continued":false}

字段说明：
- label：题号（如「练习1」「例3」「4.」）；没有题号就写空字符串
- preview：题干开头 10~15 个字，用来核对切分对不对
- box：这道题在页面上的范围，[左, 上, 右, 下]，
  都用 0~1 的相对比例（左上角是 0,0；右下角是 1,1）。拿不准就省略这个字段。
  **范围要一直框到下一道题开始之前**——配图、以及紧随其后的
  【答案】【解析】灰框都属于这道题，少框了答案就丢了
- hasFigure：这道题旁边有没有图形、表格或数阵（有就 true）
- figureBox：只在 hasFigure 为 true 时给——**题干里那张图**的范围（同样是 0~1 比例）。
  宁可框大一点把整张图都包进去，也不要框小了切掉图的一角；拿不准就省略
- analysisFigureBox：**【答案】【解析】那个灰框里**如果另有一张图，给出它的范围。
  教师版常在解析里再画一张（割补怎么割、阴影怎么挪、辅助线画在哪）——
  那张图是解法，不属于题干，必须和 figureBox 分开
- answerTop：这道题的【答案】灰框**从哪一行开始**（只写上边缘那一个 0~1 的数）。
  没有灰框（学生版）就省略。这条用来复核上面两个框有没有标反。
  **这一页开头就是上一页那道题的答案/解析时，answerTop 写 0**——
  那说明这一段里没有任何题干，图都是解法图
- continued：只有第一道题可能为 true——当这一页开头是上一页某题的续文时
- continuedKind：continued 为 true 时必填，二选一——
  写 "stem" = 上一页那道题的**题干还没写完**（比如第二个小问、或配图落在了这一页）；
  写 "answer" = 接的是上一页那道题的**【答案】【解析】**（推演表、分解图、结论都算）。
  拿不准写 "answer"

**跨页的那一半也要输出**，这是最容易漏的一处：
- 只有「(2)」「②」这样一个小问，没有题号、看着不像一道完整的题 → 照样输出，continued 写 true
- 这一页开头只有上一页那道题的【答案】【解析】（连题干都没有）→ 也要输出一条，
  continued 写 true、answerTop 写 0。漏掉它，上一页那道题的答案就永远找不回来了

除此之外，页眉、页脚、章节标题、纯讲解文字都不是题，不要输出。
这一页没有任何题目内容才什么都不输出。`;

export const CONTENT_PROMPT = `这张图是**一道**数学题（可能带图）。抽出它的内容，输出**一个** JSON 对象（不要数组、不要围栏）：
{"stem":"完整题干","answer":"答案","answerFrom":"material|solved","answerUnique":true,"answerType":"numeric|expression|steps","options":["A",...],"analysis":"一句话解析","difficulty":1,"level":"elementary_lower|elementary_upper|middle|high|advanced"}
规则：
- stem 保留原题完整信息（数字、单位、条件），不要改写；图里的数字务必看准；
- 分数、根号、角度这些**要写成 LaTeX 并用 $ 包起来**：$50\\frac{1}{4}$、$\\sqrt{16}$、$45^\\circ$。
  不加 $ 的话界面上会原样显示成源码；带分数要连整数部分一起包进去；
- answer 只写最终答案（数值题只写数，不带单位）；材料没给答案就自己解出来，解不出留空字符串；
- **answerFrom 必须如实写**：答案是从图里【答案】栏读到的就写 material，
  是你自己算出来的就写 solved。这两者要分开——你算的那个会被标出来让人复核，
  写错了会让一个没人核对过的数当成原题答案；
- analysis 一句话即可，不要写解题全过程；
- **answerUnique**：这道题的正确答案是不是只有一种。
  填运算符、数阵图、"写出一个满足…的数"这类题往往有多种解法——
  讲义里出现「或」「答案不唯一」「方法一/方法二」时一律写 false。
  写错了会让做对的孩子被判错，那是最伤的一种错；
- options 仅选择题才有；difficulty 为 1-5 的整数；
- **answerType 看的是"能不能对着答案判对错"，不是"答案有几个数"**：
  一个或多个数值（"44，20"、"16，256"）都写 numeric，多个答案之间用逗号分开；
  含字母的代数式写 expression；
  只有必须看解题过程才判得了的（推理题的对应关系、证明）才写 steps。
不要描述图形长什么样——那由另一步单独处理。`;

export const FIGURE_PROMPT = `这张图里有一道带图的数学题。**只**描述它的图形，用「点线角 + 约束」，不要描述像素、不要重复题干。
输出一个 JSON 对象（不要数组、不要围栏）：
{"points":[{"id":"A"},{"id":"B"},{"id":"C"}],
 "segments":[{"from":"A","to":"B","label":"3 厘米"},{"from":"B","to":"C"},{"from":"C","to":"A"}],
 "angles":[{"at":"B","from":"A","to":"C","right":true}],
 "polygons":[{"points":["A","B","C"],"shaded":false}],
 "constraints":[{"kind":"length","from":"A","to":"B","value":3},
                {"kind":"right-angle","at":"B","from":"A","to":"C"}]}
约束可用：length、equal-length、angle（degrees）、right-angle、parallel、perpendicular、
on-segment（可带 ratio 表示分点比例）。

两条硬规则：
- **只写题干明确给出的量**。图上量着像 5 但题干没说，就不许写 length=5——
  多写一个条件，这道题就从"要推"变成"看图就有答案"了。
- 条件必须能画得出来（不自相矛盾）。
图形太复杂（辅助线堆叠、立体图、函数图像）写不清楚时，输出 {} 即可，不要硬凑。`;

/**
 * 一页的开头是上一页那道题的后半截（多半整块都是【答案】【解析】）时用它。
 *
 * 为什么单独一套：这块图里根本没有题干，按常规提示词去问，模型会把
 * 解析里的例子当成新题目抽出来，或者干脆答一片空。而这块内容偏偏很要紧——
 * 上一页那道题的答案就在里面，漏掉它那道题就永远没有答案。
 */
export const TAIL_PROMPT = `这张图是**上一页那道题的后半截**，通常整块都是【答案】【解析】，里面没有新的题目。

请输出**一个** JSON 对象（不要数组、不要围栏）：
{"answer":"答案","answerFrom":"material|solved","analysis":"一句话解析","hasFigure":true|false}
规则：
- answer 只写【答案】栏里的那个最终答案（数值题只写数，不带单位）；找不到就留空字符串；
- answerFrom：从图里读到的写 material，你自己算的写 solved；
- analysis 一句话概括解法即可，不要抄整段；
- hasFigure：这一块里有没有画图形（解析里的示意图、分解图、数阵）。
**不要把解析里举的例子当成新题目**，也不要输出题干。`;

export function contentUserPrompt(level?: EducationLevel, carryOver?: string): string {
  const lv = level ? `材料年级：${level}。` : "";
  // 跨页题：把上一页残缺的开头交给模型，让它把两半拼成一道完整的题
  const carry = carryOver
    ? `\n注意：这道题的开头在上一页，内容是「${carryOver}」，请把它与本图的内容拼成完整题干。`
    : "";
  return `${lv}${CONTENT_PROMPT}${carry}`;
}

export function tailUserPrompt(carryOver?: string): string {
  const carry = carryOver ? `\n上一页那道题的题干是「${carryOver}」。` : "";
  return `${TAIL_PROMPT}${carry}`;
}

function stripFence(raw: string): string {
  const text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) return fence[1]!.trim();
  // 围栏没闭合（截断的症状）时取开围栏之后的全部内容
  if (text.startsWith("```")) return text.replace(/^```(?:json)?\s*/i, "");
  return text;
}

/**
 * 取**最外层**那一个 JSON 对象。
 *
 * 配图规格是一个多行展开的大对象，不能按行扫——里面的
 * `{"id": "A"},` 自己就是一行合法 JSON，按行扫会先抓到它，
 * 于是整张图变成了一个点，报出莫名其妙的「points Required」。
 * 实机上就是这么坏的。所以这里按括号配对，从第一个 `{` 找到与它配对的 `}`。
 */
export function parseFirstObject(raw: string): unknown {
  const text = stripFence(raw);
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  // 没配对上 = 被截断了。宁可当作没有图，也不能交出半张
  return undefined;
}

/** 从模型输出里逐行抠 JSON 对象（版面那趟专用：一行一题，截断只丢最后一行） */
export function parseJsonObjects(raw: string): unknown[] {
  const text = stripFence(raw);

  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/^[[,]\s*/, "").replace(/[,\]]\s*$/, "");
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 这一行坏掉不影响别的行 */
    }
  }
  if (out.length === 0) {
    // 一行都没抠出来：模型把整个对象展开成了多行，改按括号配对取最外层
    const single = parseFirstObject(text);
    if (single !== undefined) out.push(single);
  }
  return out;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * 校验版面框。不可用就丢掉框（保留这道题，用整页图跑第二趟）——
 * 裁错了比不裁更糟：裁走半道题，后面全是错的，而且看不出来。
 */
export function normalizeBox(
  raw: unknown,
  minWidth = 0.15,
  minHeight = 0.03,
): [number, number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length < 4) return undefined;
  const v = raw.map(num);
  if (v.some((x) => x === undefined)) return undefined;
  let [x0, y0, x1, y1] = v as [number, number, number, number];
  // 有的模型给 0~100 的百分数，有的给像素；>1 一律按百分数理解，超出再判废
  if (x1 > 1 || y1 > 1) {
    if (x1 <= 100 && y1 <= 100) { x0 /= 100; y0 /= 100; x1 /= 100; y1 /= 100; }
    else return undefined;
  }
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(1, x1); y1 = Math.min(1, y1);
  // 太窄太扁的框多半是模型瞎给的：裁出来看不清，不如用整页
  if (x1 - x0 < minWidth || y1 - y0 < minHeight) return undefined;
  return [x0, y0, x1, y1];
}

/**
 * 把每道题的下边界推到下一道题的上边界。
 *
 * 拿真讲义量过：模型框的是"看上去的那道题"——题号、题干、配图，
 * 到此为止。可教师版把【答案】【解析】放在紧随其后的灰框里，
 * 于是裁出来的图**恰好缺了答案**。而缺答案不会报错：内容趟会按提示词
 * "自己解出来"，给出一个看着合理、却没人核对过的数——比抽不出来坏得多。
 *
 * 讲义里题是竖着排的，所以"这道题的答案"必然落在它与下一道题之间。
 * 把下边界推到下一道的上边界，就把那块地必然收进来了，
 * 不用指望模型每次都记得框上答案。多收进来的顶多是个小标题，无害。
 */
export function snapBoxes(items: LayoutItem[]): LayoutItem[] {
  return items.map((item, i) => {
    if (!item.box) return item;
    // 往下找到第一个有框的题；中间没框的题不能作为边界（它的位置是未知的）
    const next = items.slice(i + 1).find((n) => n.box);
    const floor = next?.box ? next.box[1] : 1;
    // 只往下扩，绝不上收：模型给的下边界已经够低时保持原样
    if (floor <= item.box[3]) return item;
    return { ...item, box: [item.box[0], item.box[1], item.box[2], floor] as [number, number, number, number] };
  });
}

export function parseLayout(raw: string): LayoutItem[] {
  let items: LayoutItem[] = [];
  for (const obj of parseJsonObjects(raw)) {
    if (typeof obj !== "object" || obj === null) continue;
    const o = obj as Record<string, unknown>;
    const preview = String(o.preview ?? o.stem ?? "").trim();
    if (!preview && o.label === undefined) continue;
    items.push({
      index: num(o.index) ?? items.length + 1,
      label: String(o.label ?? "").trim(),
      preview,
      box: normalizeBox(o.box ?? o.bbox ?? o.rect),
      hasFigure: o.hasFigure === true || o.has_figure === true,
      // 配图框可以比题目框松：它只用来裁一张给人看的图，
      // 不像题目框那样切错了会让整道题的内容全错
      ...(() => {
        const fb = normalizeBox(o.figureBox ?? o.figure_box, 0.05, 0.02);
        return fb ? { figureBox: fb } : {};
      })(),
      ...(() => {
        const ab = normalizeBox(o.analysisFigureBox ?? o.analysis_figure_box, 0.05, 0.02);
        return ab ? { analysisFigureBox: ab } : {};
      })(),
      ...(() => {
        // 有的模型给 0~100 的百分数，与 normalizeBox 同一套理解
        let top = num(o.answerTop ?? o.answer_top);
        if (top !== undefined && top > 1) top = top <= 100 ? top / 100 : undefined;
        // **0 是有意义的值**：续页开头就是上一页那道题的答案/解析，
        // 这一段里没有任何题干，所以图全是解法图。一度把它当"没给"丢掉，
        // 于是解法图被判成题干图——正是跨页时出错的那条路径。
        return top !== undefined && top >= 0 && top < 1 ? { answerTop: top } : {};
      })(),
      continued: o.continued === true,
      ...(o.continued === true
        ? { continuedKind: o.continuedKind === "stem" ? ("stem" as const) : ("answer" as const) }
        : {}),
    });
  }
  /**
   * 按纵向位置排序，但**没有框的条目不能当成 y=0**。
   *
   * 曾经写成 `a.box?.[1] ?? 0`：页脚那个光杆题号（框太窄被判废、没有框）
   * 于是排到了整页最前面——它明明在页面最底下。排错了位置，
   * "最后一条是不是光杆题号"就检测不出来，snapBoxes 补边界也会补错。
   *
   * 没有框就沿用模型给出的阅读顺序：紧跟在它前面那条之后。
   */
  let lastTop = 0;
  const keyed = items.map((item, i) => {
    if (item.box) lastTop = item.box[1];
    // 加一点点增量，保证与前一条的先后关系稳定
    return { item, key: item.box ? item.box[1] : lastTop + 1e-6 * (i + 1) };
  });
  keyed.sort((a, b) => a.key - b.key || a.item.index - b.item.index);
  items = keyed.map((k) => k.item);
  // 先排序再补边界：补的依据就是"下一道题在哪"，顺序错了就补错了
  return snapBoxes(items);
}

/** 框的可用率：低到一定程度就该换模型，这个数得让人看得见 */
export function boxQuality(items: LayoutItem[]): { total: number; withBox: number; ratio: number } {
  const withBox = items.filter((i) => i.box).length;
  return { total: items.length, withBox, ratio: items.length ? withBox / items.length : 0 };
}
