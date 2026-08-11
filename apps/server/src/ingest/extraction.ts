import { LlmClient, loadLlmConfig, type ChatMessage } from "@mathtutor/llm-client";
import { z } from "zod";
import { EducationLevelSchema, type EducationLevel, type FigureSpec } from "@mathtutor/schema";
import type { Knowledge } from "@mathtutor/knowledge";
import { checkFigure } from "./figureGate.js";
import { vocabularyPrompt } from "./vocabulary.js";

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
  options?: string[];
  analysis?: string;
  difficulty: number;
  level: EducationLevel;
}

export interface ExtractionProvider {
  extractFromText(text: string, hint?: ExtractionHint): Promise<ExtractedDraft[]>;
  extractFromImage(base64: string, mime: string, hint?: ExtractionHint): Promise<ExtractedDraft[]>;
}

/** 抽取时可用的知识层（拼候选清单用）；不给则退回纯离线定位 */
export interface ExtractionKnowledge {
  knowledge: Knowledge;
}

const DEFAULT_LEVEL: EducationLevel = "elementary_upper";

// ---------------------------------------------------------------------------
// LLM 输出解析（容错：markdown 代码块、单对象、字段缺失/类型飘移）
// ---------------------------------------------------------------------------

const LenientDraftSchema = z.object({
  stem: z.string().min(1),
  answer: z.union([z.string(), z.number()]).optional(),
  answerType: z.enum(["numeric", "expression", "steps"]).optional(),
  options: z.array(z.union([z.string(), z.number()])).optional(),
  analysis: z.string().optional(),
  difficulty: z.coerce.number().optional(),
  level: EducationLevelSchema.optional(),
  // 宽松收下：合法性与真实性交给 checkFigure，这里不拦
  figure: z.unknown().optional(),
  // 模型给的说法五花八门（id、名字、近似说法），一律先收下再吸附
  nodeIds: z.array(z.union([z.string(), z.number()])).optional(),
  problemTypeId: z.union([z.string(), z.number()]).optional(),
});

function normalizeDraft(item: z.infer<typeof LenientDraftSchema>, fallbackLevel: EducationLevel): ExtractedDraft {
  const difficulty = Number.isFinite(item.difficulty)
    ? Math.min(5, Math.max(1, Math.round(item.difficulty!)))
    : 2;
  const stem = item.stem.trim();
  const fig = checkFigure(item.figure, stem);
  return {
    stem,
    ...(fig.figure ? { figure: fig.figure } : {}),
    ...(fig.rejected ? { figureRejected: fig.rejected } : {}),
    ...(item.nodeIds?.length ? { proposedNodeIds: item.nodeIds.map(String) } : {}),
    ...(item.problemTypeId !== undefined ? { proposedProblemTypeId: String(item.problemTypeId) } : {}),
    answer: item.answer === undefined ? "" : String(item.answer).trim(),
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

export interface ParseOutcome {
  drafts: ExtractedDraft[];
  /** 被跳过的对象数（截断或格式坏掉）；> 0 时调用方应当提示 */
  skipped: number;
}

/** 解析 LLM 的 JSON 数组输出：剥离围栏、逐个对象解析，坏的跳过不牵连好的 */
export function parseExtractionOutcome(raw: string, fallbackLevel: EducationLevel): ParseOutcome {
  let text = raw.trim();
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
  // 一个都没抠出来才算真失败——那多半不是截断，是模型压根没按格式输出
  if (drafts.length === 0 && chunks.length === 0) {
    // 分清两种情况：确实没给 JSON，还是给了但在第一个对象里就被截断了。
    // 后者是输出预算问题，说成"找不到 JSON"会把人引到错误的方向。
    const truncated = text.includes("{") && !text.trimEnd().endsWith("}");
    throw new Error(
      truncated
        ? `模型输出在第一道题中间就被截断了（收到 ${text.length} 字符）：这一页题太多或解析写得太长，已跳过该页`
        : `LLM 输出里找不到任何 JSON 对象（前 120 字：${text.slice(0, 120)}）`,
    );
  }
  return { drafts, skipped };
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
- answer 只写最终答案（数值题只写数，不带单位）；材料没给答案就自己解出来，解不出留空字符串；
- answerType：单个数值答案用 numeric，代数式用 expression，需要多步说明的用 steps；
- options 仅选择题才有，其他题省略该字段；
- difficulty 为 1-5 的整数；
- 材料里没有题目时什么都不输出。
- analysis 一句话即可，不要写解题全过程——写长了会把后面的题挤掉。

**如果题目带图（几何题居多），再加一个 figure 字段，用「点线角 + 约束」描述这张图，不要描述像素**：
{"figure":{
  "points":[{"id":"A"},{"id":"B"},{"id":"C"}],
  "segments":[{"from":"A","to":"B","label":"3 厘米"},{"from":"B","to":"C"},{"from":"C","to":"A"}],
  "angles":[{"at":"B","from":"A","to":"C","right":true}],
  "polygons":[{"points":["A","B","C"],"shaded":false}],
  "constraints":[
    {"kind":"length","from":"A","to":"B","value":3},
    {"kind":"right-angle","at":"B","from":"A","to":"C"}]}}
约束可用：length（边长）、equal-length（两边等长）、angle（度数）、right-angle（直角）、
parallel（平行）、perpendicular（垂直）、on-segment（点在线段上，可带 ratio 表示分点比例）。
两条硬规则：
- **只写题干明确给出的量**。图上量着像 5 但题干没说，就不许写 length=5——
  多写一个条件，这道题就从"要推"变成"看图就有答案"了。
- 条件必须能画得出来（不自相矛盾）。画不出来的会被丢弃，题目本身仍会保留。
没有图的题就不要 figure 字段。`;

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
async function collectText(client: LlmClient, messages: ChatMessage[]): Promise<string> {
  let text = "";
  for await (const ev of client.chat(messages, { maxTokens: 8192, temperature: 0.2 })) {
    if (ev.type === "text") text += ev.text;
  }
  return text;
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
  };
}
