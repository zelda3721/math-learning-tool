import { LlmClient, loadLlmConfig, type ChatMessage } from "@mathtutor/llm-client";
import { z } from "zod";
import { EducationLevelSchema, type EducationLevel, type FigureSpec } from "@mathtutor/schema";
import type { Knowledge } from "@mathtutor/knowledge";
import { checkFigure } from "./figureGate.js";
import { vocabularyPrompt } from "./vocabulary.js";
import {
  contentUserPrompt,
  parseFirstObject,
  parseLayout,
  repairJsonEscapes,
  tailUserPrompt,
  FIGURE_PROMPT,
  LAYOUT_PROMPT,
  type LayoutItem,
} from "./passes.js";

/**
 * 抽取 Provider：把原始材料（文本 / 图片）变成题目草稿。
 * 文本走 fast 端点，图片走 vision 端点（OpenAI 格式 image_url data URL）。
 * provider 为 null 时上传管线走离线兜底（见 offlineTextDrafts）。
 */

export interface ExtractionHint {
  /** 材料的目标年级（用户在上传界面选择） */
  level?: EducationLevel;
  /**
   * 有题目因输出截断或格式坏掉被跳过时回调。
   * 静默丢题是最伤信任的事——上传的人以为这页只有 8 道，其实模型给了 12 道。
   */
  onSkipped?: (count: number) => void;
}

/** 抽取出的题目草稿（未定位、未入库） */
export interface ExtractedDraft {
  stem: string;
  /** 几何题的配图规格（过门禁后才带上；见 figureGate.ts） */
  figure?: FigureSpec;
  /** 配图被丢弃的原因（家长抽检时要看到） */
  figureRejected?: string;
  /** 模型提议的知识点/题型（原样，未吸附）；由 locateDraft 吸附到图谱 */
  proposedNodeIds?: string[];
  proposedProblemTypeId?: string;
  answer: string;
  answerType: "numeric" | "expression" | "steps";
  /**
   * 答案是模型自己解的，材料里并没有。
   *
   * 学生版讲义不印答案，模型就会按提示词自己算一个——实测同一道数三角形的题
   * 两次分别给出 48 和 84。这种数一旦以"抽取到的答案"的身份进库，
   * 孩子做错了会被判对、做对了会被判错，而且没人知道是从哪坏的。
   * 标出来，让家长在抽检时一眼看见哪些答案还没人核对过。
   */
  answerUnverified?: boolean;
  /** 答案不唯一（巧填算符这类多解题）：对不上时交给家长，不判错 */
  answerUnique?: boolean;
  options?: string[];
  analysis?: string;
  difficulty: number;
  level: EducationLevel;
}

/** 跨页后半截的抽取结果：上一页那道题的答案与解析 */
export interface QuestionTail {
  answer: string;
  answerUnverified?: boolean;
  analysis?: string;
  /** 这一块里有没有画图形（有就把它裁下来当解析配图） */
  hasFigure: boolean;
}

export interface ExtractionProvider {
  extractFromText(text: string, hint?: ExtractionHint): Promise<ExtractedDraft[]>;
  extractFromImage(base64: string, mime: string, hint?: ExtractionHint): Promise<ExtractedDraft[]>;
  /**
   * 分层抽取的三趟（见 passes.ts）。可选：老的测试替身与离线兜底不实现它们，
   * 路由检测到没有就退回整页一次抽取。
   */
  layoutFromImage?(base64: string, mime: string): Promise<LayoutItem[]>;
  /** 一道题的内容（图应当是裁好的单题）；读不出来返回 null。photo=随手拍的照片（忽略手写） */
  questionFromImage?(
    base64: string,
    mime: string,
    hint?: ExtractionHint & { carryOver?: string; photo?: boolean },
  ): Promise<ExtractedDraft | null>;
  /** 只要配图规格，原样返回（合法性与真实性由 checkFigure 把关） */
  figureFromImage?(base64: string, mime: string): Promise<unknown>;
  /**
   * 照片方向：**顺时针**转多少度文字才是正的。
   * 手机拍题经常侧着拍，而微信传图会把 EXIF 方向信息剥掉（实机验证过），
   * 浏览器的自动转正因此失效——只能看内容判。判不出按 0 处理。
   */
  orientationFromImage?(base64: string, mime: string): Promise<Orientation>;
  /** 跨页的后半截（整块是【答案】【解析】）：只补答案与解析，不抽题干 */
  tailFromImage?(base64: string, mime: string, carryOver?: string): Promise<QuestionTail | null>;
}

/** 抽取时可用的知识层（拼候选清单用）；不给则退回纯离线定位 */
export interface ExtractionKnowledge {
  knowledge: Knowledge;
}

const DEFAULT_LEVEL: EducationLevel = "elementary_upper";

// ---------------------------------------------------------------------------
// LLM 输出解析（容错：markdown 代码块、单对象、字段缺失/类型飘移）
// ---------------------------------------------------------------------------

/**
 * 收下模型的输出。**每个可选字段都要能接住 `null`。**
 *
 * 这是实机上丢题最多的一处，而且藏得极深：模型时而写 `"problemTypeId":""`、
 * 时而写 `"problemTypeId":null`，写 null 那次整道题就被 schema 判废、
 * 静默丢掉——界面上只剩一句"这一块没读出题目"。同一张图连打两次一次成一次败，
 * 看着像模型随机，其实是这里。一份 13 道的讲义反复抽出 8~11 道，根子在此。
 *
 * 所以：可选字段一律 `.nullable()`，null 与缺失同等对待。
 * 抽取器的职责是**尽量把题接住**，字段脏了后面还有门禁与人工抽检，
 * 而丢掉的题谁也找不回来。
 */
const nullish = <T extends z.ZodTypeAny>(schema: T) => schema.nullish();

const LenientDraftSchema = z.object({
  stem: z.string().min(1),
  answer: nullish(z.union([z.string(), z.number()])),
  answerType: nullish(z.enum(["numeric", "expression", "steps"])),
  options: nullish(z.array(z.union([z.string(), z.number()]))),
  analysis: nullish(z.string()),
  difficulty: nullish(z.coerce.number()),
  level: nullish(EducationLevelSchema),
  /** 分层的内容趟要求模型自报答案出处（见 ExtractedDraft.answerUnverified） */
  answerFrom: nullish(z.string()),
  answerUnique: nullish(z.boolean()),
  // 宽松收下：合法性与真实性交给 checkFigure，这里不拦
  figure: z.unknown().optional(),
  // 模型给的说法五花八门（id、名字、近似说法），一律先收下再吸附
  nodeIds: nullish(z.array(z.union([z.string(), z.number()]))),
  problemTypeId: nullish(z.union([z.string(), z.number()])),
});

function normalizeDraft(item: z.infer<typeof LenientDraftSchema>, fallbackLevel: EducationLevel): ExtractedDraft {
  const difficulty = Number.isFinite(item.difficulty ?? NaN)
    ? Math.min(5, Math.max(1, Math.round(item.difficulty!)))
    : 2;
  const stem = item.stem.trim();
  const fig = checkFigure(item.figure, stem);
  return {
    stem,
    ...(fig.figure ? { figure: fig.figure } : {}),
    ...(fig.rejected ? { figureRejected: fig.rejected } : {}),
    ...(item.nodeIds?.length ? { proposedNodeIds: item.nodeIds.map(String) } : {}),
    ...(item.problemTypeId != null ? { proposedProblemTypeId: String(item.problemTypeId) } : {}),
    answer: item.answer == null ? "" : String(item.answer).trim(),
    // 只有明确说了 material 才算材料给的。字段缺失时（老的整页路径不问这个）
    // 不标记——那条路上答案通常确实来自教师版，乱标会让抽检页全是红字而失去意义
    ...(item.answerFrom === "solved" ? { answerUnverified: true } : {}),
    // 只在模型明说 false 时记下来：缺省（老路径不问这个）按唯一处理
    ...(item.answerUnique === false ? { answerUnique: false } : {}),
    answerType: item.answerType ?? "numeric",
    options: item.options?.length ? item.options.map(String) : undefined,
    analysis: item.analysis?.trim() || undefined,
    difficulty,
    level: item.level ?? fallbackLevel,
  };
}

/**
 * 逐个抠出数组里的顶层对象。
 *
 * 不用 JSON.parse 整段，是因为输出被截断时整段必然解析失败，
 * 前面十几道已经完整的题会跟着一起丢——实机上就发生了：
 * 一页 12 道题，模型在第 92 行断掉，整页颗粒无收。
 * 逐个解析则只损失最后那个残缺的对象。
 */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { if (depth === 0) start = i; depth += 1; }
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
      if (depth < 0) depth = 0; // 多余的右括号：忽略，别让整段崩掉
    }
  }
  return out;
}

/** 一行一个 JSON 对象：截断只影响最后一行，前面的行原封不动 */
function lineObjects(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/^[[,]\s*/, "").replace(/[,\]]\s*$/, "");
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    out.push(t);
  }
  return out;
}

/**
 * 小问编号（不锚定开头）：「（1）」「(2)」「①」，**也认「（$1$）」**——
 * 提示词要求数字用 $ 包起来，模型把小问编号也一并包了，
 * 实机上练习13 的三条碎片就是靠 `（$1$）` 躲过合并的。
 */
const SUB_MARKER = /[(（]\s*\$?\s*\d+\s*\$?\s*[)）]|[①②③④⑤⑥⑦⑧⑨⑩]/;

/** 按第一个小问编号把题干拆成「头 + 尾」；没有编号返回 null */
function splitAtMarker(stem: string): { head: string; tail: string } | null {
  const m = SUB_MARKER.exec(stem);
  if (!m) return null;
  return { head: stem.slice(0, m.index).trim(), tail: stem.slice(m.index).trim() };
}

const squash = (t: string) => t.replace(/\s+/g, "");

/**
 * 把被拆散的小问并回它的主题干。
 *
 * 模型拆一题多问有**两种花样**，都在实机上见过：
 * ① 光杆小问：「(1) 根据统计表…」「(2) 绘制统计图…」——头是空的；
 * ② 重复题干：每条都是「完整题干＋一个小问」——
 *    「根据某小学…回答下列问题．（1）四年级…」
 *    「根据某小学…回答下列问题．（2）丁丁…」
 *    「根据某小学…回答下列问题．（3）你还能…」
 *    第二种更隐蔽：开头不是编号，按"开头是小问"的判据完全看不见，
 *    第14讲练习6 连着两轮就是这么漏掉的。
 *
 * 统一判据：按第一个小问编号拆出「头」，相邻两条的头对得上
 * （光杆的头是空串；重复题干的头是同一段话）就是同一道题——
 * 合并时只留一份题干，小问接排，答案用分号接。
 */
export function coalesceSubQuestions(drafts: ExtractedDraft[]): ExtractedDraft[] {
  const out: ExtractedDraft[] = [];
  for (const d of drafts) {
    const prev = out[out.length - 1];
    const cur = splitAtMarker(d.stem.trim());
    const mergeable =
      prev !== undefined &&
      cur !== null &&
      (cur.head === "" ||
        // 重复题干：头得够长（短前缀撞车太容易），且上一条确实以它开头
        (squash(cur.head).length >= 8 && squash(prev.stem).startsWith(squash(cur.head))));
    if (!mergeable) {
      out.push(d);
      continue;
    }
    const answers = [prev.answer, d.answer].map((a) => a.trim()).filter(Boolean);
    out[out.length - 1] = {
      ...prev,
      stem: `${prev.stem.trimEnd()}\n${cur.tail}`,
      answer: [...new Set(answers)].join("；"),
      figure: prev.figure ?? d.figure,
      analysis: prev.analysis ?? d.analysis,
      ...(prev.answerUnverified || d.answerUnverified ? { answerUnverified: true } : {}),
      ...(prev.answerUnique === false || d.answerUnique === false ? { answerUnique: false } : {}),
    };
  }
  return out;
}

export interface ParseOutcome {
  drafts: ExtractedDraft[];
  /** 被跳过的对象数（截断或格式坏掉）；> 0 时调用方应当提示 */
  skipped: number;
  /** 这一页确实没有题目（封面、章节页、整页解析），不是失败 */
  empty?: boolean;
}

/** 解析 LLM 的 JSON 数组输出：剥离围栏、逐个对象解析，坏的跳过不牵连好的 */
export function parseExtractionOutcome(raw: string, fallbackLevel: EducationLevel): ParseOutcome {
  // 模型写题干时会带 LaTeX，而 `\div` 在 JSON 里是非法转义，
  // JSON.parse 会把整道题连带扔掉——这是实机上丢题最多的一处
  let text = repairJsonEscapes(raw.trim());
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  // 围栏没闭合（同样是截断的症状）时，取开围栏之后的全部内容
  else if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "");

  const harvest = (chunks: string[]) => {
    const drafts: ExtractedDraft[] = [];
    let skipped = 0;
    for (const chunk of chunks) {
      let obj: unknown;
      try {
        obj = JSON.parse(chunk);
      } catch {
        skipped += 1;
        continue;
      }
      const r = LenientDraftSchema.safeParse(obj);
      if (r.success) drafts.push(normalizeDraft(r.data, fallbackLevel));
      else skipped += 1;
    }
    return { drafts, skipped };
  };

  // 先按行解析（我们要求的就是一行一题）：一行坏掉只影响那一行。
  // 一条都没解出来才退回括号配对——模型未必照做（比如仍旧给一整行的数组），得兜住。
  let { drafts, skipped } = harvest(lineObjects(text));
  let chunks = lineObjects(text);
  if (drafts.length === 0) {
    chunks = balancedObjects(text);
    ({ drafts, skipped } = harvest(chunks));
  }
  if (drafts.length === 0 && chunks.length === 0) {
    /**
     * 一个对象都没抠出来，只有一种情况算失败：**被截断**。
     *
     * 输出里有 `{` 却没收尾，说明模型开了头写不完——那是输出预算问题，
     * 得报出来让人知道这一页丢了。
     *
     * 而**一个 `{` 都没有**是正常的：提示词自己就写着"材料里没有题目时
     * 什么都不输出"，封面页、章节页、整页解析都会走到这里。
     * 此前一律抛错，于是一本讲义里几张没有题的页面就成了刺眼的红色报错
     * （实机上是「材料中没有题目，不输出任何内容。」被当成了失败）。
     * 这不是错，是这一页真的没题。
     */
    // 有 `{` 却一个完整对象都抠不出来，只可能是写到一半断了：
    // 只要存在一对配对的括号，balancedObjects 就会抠出块来（那时 chunks 不为空，
    // 走不到这里，坏掉的块记进 skipped 由调用方提示）。
    if (text.includes("{")) {
      throw new Error(
        `模型输出在第一道题中间就被截断了（收到 ${text.length} 字符）：这一页题太多或解析写得太长，已跳过该页`,
      );
    }
    return { drafts: [], skipped: 0, empty: true };
  }
  // 被拆散的小问并回主题干（详见 coalesceSubQuestions——孤儿小问没法答，还会顶掉配图）
  return { drafts: coalesceSubQuestions(drafts), skipped };
}

/** 兼容既有调用方 */
export function parseExtractionJson(raw: string, fallbackLevel: EducationLevel): ExtractedDraft[] {
  return parseExtractionOutcome(raw, fallbackLevel).drafts;
}

// ---------------------------------------------------------------------------
// 离线兜底：按题号正则分块（1. / 1、 / （1） / 例1 / 第1题）
// ---------------------------------------------------------------------------

const QUESTION_MARKER =
  /^\s*(?:例\s*\d{1,3}\s*[.、．:：)）]?|第\s*\d{1,3}\s*题\s*[.、．:：]?|\d{1,3}\s*[.、．)）]|[（(]\s*\d{1,3}\s*[)）])\s*/;

/** 按题号把整段文本切成题干块；没有任何题号时整段视为一题 */
export function segmentQuestionsOffline(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const markerAt = lines.map((line) => QUESTION_MARKER.test(line));
  if (!markerAt.some(Boolean)) {
    const whole = text.trim();
    return whole ? [whole] : [];
  }
  const blocks: string[] = [];
  let current: string[] | null = null; // 首个题号之前的前言（标题等）丢弃
  for (let i = 0; i < lines.length; i++) {
    if (markerAt[i]) {
      if (current) {
        const block = current.join("\n").trim();
        if (block) blocks.push(block);
      }
      current = [lines[i]!.replace(QUESTION_MARKER, "")];
    } else if (current) {
      current.push(lines[i]!);
    }
  }
  if (current) {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
  }
  return blocks.filter((b) => b.length >= 2);
}

/** 教师版常见的行内答案/解析标注（「答案：27 棵。解析：45-18=27。」），确定性可解析 */
const ANSWER_PATTERN = /答案[：:]\s*([^\n。；;]+)[。；;]?/;
const ANALYSIS_PATTERN = /(?:解析|详解|分析)[：:]\s*([^\n]+)/;

/**
 * 离线文本兜底：分块成题干草稿。教师版行内「答案：/解析：」标注会被
 * 确定性解析进对应字段并从题干剥离；没有标注则答案留空待人工填写。
 */
export function offlineTextDrafts(text: string, level: EducationLevel = DEFAULT_LEVEL): ExtractedDraft[] {
  return segmentQuestionsOffline(text).map((block) => {
    const answerMatch = ANSWER_PATTERN.exec(block);
    const analysisMatch = ANALYSIS_PATTERN.exec(block);
    const stem = block
      .replace(ANALYSIS_PATTERN, "")
      .replace(ANSWER_PATTERN, "")
      .replace(/\s+$/, "")
      .trim();
    return {
      stem: stem || block,
      answer: answerMatch?.[1]?.trim() ?? "",
      answerType: "numeric" as const,
      difficulty: 2,
      level,
      ...(analysisMatch ? { analysis: analysisMatch[1]!.trim() } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// LLM Provider 实现
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是数学题目抽取器。从用户材料中抽出全部数学题。

**输出格式：一行一道题，每行一个完整的 JSON 对象**（不要包成数组，不要代码围栏，不要任何其他文字）。
一行写完就换行写下一题，中途不要换行——这样即使输出被截断，前面的题也都还能用。

每行形如：
{"stem":"完整题干","answer":"答案","answerType":"numeric|expression|steps","options":["选项A",...],"analysis":"简要解析","difficulty":1,"level":"elementary_lower|elementary_upper|middle|high|advanced"}
规则：
- stem 保留原题完整信息（数字、单位、条件），不要改写；
- 分数、根号、角度写成 LaTeX 并用 $ 包起来（$50\\frac{1}{4}$、$\\sqrt{16}$、$45^\\circ$）；
- answer 只写最终答案（数值题只写数，不带单位）；材料没给答案就自己解出来，解不出留空字符串；
- answerUnique：正确答案是不是只有一种。填运算符、数阵图、"举一个例子"这类
  往往多解；材料里出现「或」「答案不唯一」「方法一/方法二」时写 false；
- answerType 看的是"能不能对着答案判对错"，不是"答案有几个数"：
  一个或多个数值（"44，20"）都用 numeric，多个答案之间用逗号分开；
  含字母的代数式用 expression；只有必须看解题过程才判得了的才用 steps；
- options 仅选择题才有，其他题省略该字段；
- difficulty 为 1-5 的整数；
- 材料里没有题目时什么都不输出。
- analysis 一句话即可，不要写解题全过程——写长了会把后面的题挤掉。

**不要输出 figure 字段、不要用文字描述图形长什么样。**
配图走的是另一条路（原图直接从页面上裁下来）；此前让模型在这里写「点线角」规格，
对着统计图它只能硬凑出 {"kind":"value"} 这类不存在的约束，一律被门禁打回，
除了给抽检页添一行红字什么都得不到。`;

function userPrompt(text: string, hint?: ExtractionHint): string {
  const levelNote = hint?.level ? `材料年级：${hint.level}。` : "";
  return `${levelNote}请从下面的材料中抽取数学题：\n\n${text}`;
}

const IMAGE_PROMPT = "请从这张图片中抽取全部数学题（按系统提示的 JSON 数组格式输出）。";

/**
 * 一页题加上配图规格与知识点，输出很容易过万字符。
 * 4096 tokens 时实机上直接被截断，整页解析失败；这里放宽，
 * 并且解析端按对象逐个抠（见 parseExtractionOutcome），双保险。
 */
export type Orientation = 0 | 90 | 180 | 270;

/**
 * 从模型输出里抠方向。取**最后**一个合法数字：提示词要求只输出一个数，
 * 但模型偶尔会先复述选项或推理一句（"不是 90……应该是 270"），
 * 最终答案总在最后；取第一个反而会抓到推理过程里的干扰项。
 */
export function parseOrientation(raw: string): Orientation {
  const matches = raw.match(/\b(270|180|90|0)\b/g);
  const last = matches?.[matches.length - 1];
  return last ? (Number(last) as Orientation) : 0;
}

async function collectText(
  client: LlmClient,
  messages: ChatMessage[],
  maxTokens = 8192,
): Promise<string> {
  let text = "";
  for await (const ev of client.chat(messages, { maxTokens, temperature: 0.2 })) {
    if (ev.type === "text") text += ev.text;
  }
  return text;
}

/** 一图一问：分层的三趟都是这个形状 */
function imageAsk(system: string, prompt: string, base64: string, mime: string): ChatMessage[] {
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
      ],
    },
  ];
}

/** 用 @mathtutor/llm-client 构造 LLM 抽取 Provider：文本走 fast 端点，图片走 vision 端点 */
export function createLlmExtractionProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps?: ExtractionKnowledge,
): ExtractionProvider {
  const config = loadLlmConfig(env);
  // 有知识层就把候选清单拼进系统提示词：让模型点名，比事后靠关键词猜准得多
  const withVocab = (hint?: ExtractionHint) =>
    deps ? `${SYSTEM_PROMPT}\n${vocabularyPrompt(deps.knowledge, hint?.level)}` : SYSTEM_PROMPT;
  // 分层的内容趟不能复用 SYSTEM_PROMPT——那份讲的是"整页、一行一题"的格式，
  // 和"这张图就一道题、输出一个对象"直接冲突。只把知识点清单接上。
  const contentSystem = (hint?: ExtractionHint) =>
    deps
      ? `你是数学题目抽取器。${vocabularyPrompt(deps.knowledge, hint?.level)}`
      : "你是数学题目抽取器。";
  const textClient = LlmClient.fromEndpoint(config.fast);
  const visionClient = LlmClient.fromEndpoint(config.vision);
  return {
    async extractFromText(text, hint) {
      const raw = await collectText(textClient, [
        { role: "system", content: withVocab(hint) },
        { role: "user", content: userPrompt(text, hint) },
      ]);
      const outcome = parseExtractionOutcome(raw, hint?.level ?? DEFAULT_LEVEL);
      if (outcome.skipped > 0) hint?.onSkipped?.(outcome.skipped);
      return outcome.drafts;
    },
    async extractFromImage(base64, mime, hint) {
      const raw = await collectText(visionClient, [
        { role: "system", content: withVocab(hint) },
        {
          role: "user",
          content: [
            { type: "text", text: IMAGE_PROMPT },
            { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        },
      ]);
      const outcome = parseExtractionOutcome(raw, hint?.level ?? DEFAULT_LEVEL);
      if (outcome.skipped > 0) hint?.onSkipped?.(outcome.skipped);
      return outcome.drafts;
    },

    // ---- 分层抽取的三趟。每趟只干一件事，输出都短，因此都不容易被截断 ----

    async orientationFromImage(base64, mime) {
      // 输出就一个数字，但给足 token 余量：模型可能先说半句再给数
      const raw = await collectText(
        visionClient,
        imageAsk(
          "你在校正照片方向。",
          "这张照片里的印刷文字现在朝哪个方向？把图片**顺时针**旋转多少度后，文字才是正的（水平、从左往右读）？只输出一个数字：0、90、180 或 270。",
          base64,
          mime,
        ),
        512,
      );
      return parseOrientation(raw);
    },

    async layoutFromImage(base64, mime) {
      // 一页十几道题、每道一行短 JSON，1024 已经绰绰有余
      const raw = await collectText(
        visionClient,
        imageAsk(LAYOUT_PROMPT, "这一页有哪几道题？按格式逐行输出。", base64, mime),
        1536,
      );
      return parseLayout(raw);
    },

    async questionFromImage(base64, mime, hint) {
      /**
       * 重试一次。
       *
       * 这一趟是**随机失败**的：同一张裁好的单题图连打两次，一次正常返回、
       * 一次 `draft: null`，实测大约一半概率。每失败一次就静默少一道题——
       * 一份 13 道的讲义反复抽出 8~11 道，根子全在这里，与切题、跨页都无关。
       *
       * 所以失败时原样再来一次（温度 0.2 不是 0，两次不会是同一个结果）。
       * 两次都不行才认输，并把模型实际吐出来的头 120 字记下来——
       * 否则这种失败在日志里只是一句"没读出题目"，谁也查不出为什么。
       */
      const messages = imageAsk(
        contentSystem(hint),
        contentUserPrompt(hint?.level, hint?.carryOver, hint?.photo),
        base64,
        mime,
      );
      let lastRaw = "";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        lastRaw = await collectText(visionClient, messages, 2048);
        // 一张图就一道题：多解出来的忽略，取第一个（模型偶尔会把选项拆成额外对象）
        const outcome = parseExtractionOutcome(lastRaw, hint?.level ?? DEFAULT_LEVEL);
        if (outcome.drafts[0]) return outcome.drafts[0];
        console.warn(
          `[ingest] 单题抽取第 ${attempt} 次没读出题目（收到 ${lastRaw.length} 字）：` +
            JSON.stringify(lastRaw.slice(0, 120)),
        );
      }
      return null;
    },

    async tailFromImage(base64, mime, carryOver) {
      const raw = await collectText(
        visionClient,
        imageAsk("你是数学题目抽取器。", tailUserPrompt(carryOver), base64, mime),
        1024,
      );
      const obj = parseFirstObject(raw);
      if (!obj || typeof obj !== "object") return null;
      const o = obj as Record<string, unknown>;
      return {
        answer: o.answer === undefined ? "" : String(o.answer).trim(),
        ...(o.answerFrom === "solved" ? { answerUnverified: true } : {}),
        ...(typeof o.analysis === "string" && o.analysis.trim() ? { analysis: o.analysis.trim() } : {}),
        hasFigure: o.hasFigure === true,
      };
    },

    async figureFromImage(base64, mime) {
      const raw = await collectText(
        visionClient,
        imageAsk(FIGURE_PROMPT, "只描述这道题的图形。", base64, mime),
        1536,
      );
      // 必须取最外层那个对象：配图规格是多行展开的，按行扫会先抓到里面的
      // {"id":"A"}，于是整张图变成一个点，报出莫名其妙的「points Required」
      const first = parseFirstObject(raw);
      // 模型按约定用 {} 表示"画不清楚"；空对象没必要走门禁再报一次错
      if (!first || Object.keys(first as object).length === 0) return undefined;
      return first;
    },
  };
}
