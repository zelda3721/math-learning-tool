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
  /**
   * 配图本身的范围（题目框之内）。裁出来存成原题原图。
   * 给不出就退回整道题的框——多一点周围的字无害，图缺了才是事。
   */
  figureBox?: [number, number, number, number];
  /** 这一页开头是不是上一页某题的续文 */
  continued: boolean;
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
- figureBox：只在 hasFigure 为 true 时给——**那张图本身**的范围（同样是 0~1 比例）。
  宁可框大一点把整张图都包进去，也不要框小了切掉图的一角；拿不准就省略
- continued：只有第一道题可能为 true——当这一页开头是上一页某题的续文时

页眉、页脚、章节标题、纯讲解文字都不是题，不要输出。这一页没有题就什么都不输出。`;

export const CONTENT_PROMPT = `这张图是**一道**数学题（可能带图）。抽出它的内容，输出**一个** JSON 对象（不要数组、不要围栏）：
{"stem":"完整题干","answer":"答案","answerFrom":"material|solved","answerType":"numeric|expression|steps","options":["A",...],"analysis":"一句话解析","difficulty":1,"level":"elementary_lower|elementary_upper|middle|high|advanced"}
规则：
- stem 保留原题完整信息（数字、单位、条件），不要改写；图里的数字务必看准；
- answer 只写最终答案（数值题只写数，不带单位）；材料没给答案就自己解出来，解不出留空字符串；
- **answerFrom 必须如实写**：答案是从图里【答案】栏读到的就写 material，
  是你自己算出来的就写 solved。这两者要分开——你算的那个会被标出来让人复核，
  写错了会让一个没人核对过的数当成原题答案；
- analysis 一句话即可，不要写解题全过程；
- options 仅选择题才有；difficulty 为 1-5 的整数。
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

export function contentUserPrompt(level?: EducationLevel, carryOver?: string): string {
  const lv = level ? `材料年级：${level}。` : "";
  // 跨页题：把上一页残缺的开头交给模型，让它把两半拼成一道完整的题
  const carry = carryOver
    ? `\n注意：这道题的开头在上一页，内容是「${carryOver}」，请把它与本图的内容拼成完整题干。`
    : "";
  return `${lv}${CONTENT_PROMPT}${carry}`;
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
  const items: LayoutItem[] = [];
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
      continued: o.continued === true,
    });
  }
  items.sort((a, b) => (a.box?.[1] ?? 0) - (b.box?.[1] ?? 0) || a.index - b.index);
  // 先排序再补边界：补的依据就是"下一道题在哪"，顺序错了就补错了
  return snapBoxes(items);
}

/** 框的可用率：低到一定程度就该换模型，这个数得让人看得见 */
export function boxQuality(items: LayoutItem[]): { total: number; withBox: number; ratio: number } {
  const withBox = items.filter((i) => i.box).length;
  return { total: items.length, withBox, ratio: items.length ? withBox / items.length : 0 };
}
