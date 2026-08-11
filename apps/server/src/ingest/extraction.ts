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

/** 解析 LLM 的 JSON 数组输出：剥离代码块围栏、截取最外层 [] / {}，逐项宽松校验 */
export function parseExtractionJson(raw: string, fallbackLevel: EducationLevel): ExtractedDraft[] {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    text = text.slice(arrStart, arrEnd + 1);
  } else {
    const objStart = text.indexOf("{");
    const objEnd = text.lastIndexOf("}");
    if (objStart >= 0 && objEnd > objStart) text = `[${text.slice(objStart, objEnd + 1)}]`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`LLM 输出不是合法 JSON: ${String(err)}`);
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const drafts: ExtractedDraft[] = [];
  for (const item of items) {
    const r = LenientDraftSchema.safeParse(item);
    if (r.success) drafts.push(normalizeDraft(r.data, fallbackLevel));
  }
  return drafts;
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

const SYSTEM_PROMPT = `你是数学题目抽取器。从用户材料中抽出全部数学题，输出一个 JSON 数组（不要任何其他文字），每个元素形如：
{"stem":"完整题干","answer":"答案","answerType":"numeric|expression|steps","options":["选项A",...],"analysis":"简要解析","difficulty":1,"level":"elementary_lower|elementary_upper|middle|high|advanced"}
规则：
- stem 保留原题完整信息（数字、单位、条件），不要改写；
- answer 只写最终答案（数值题只写数，不带单位）；材料没给答案就自己解出来，解不出留空字符串；
- answerType：单个数值答案用 numeric，代数式用 expression，需要多步说明的用 steps；
- options 仅选择题才有，其他题省略该字段；
- difficulty 为 1-5 的整数；
- 材料里没有题目时输出 []。

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

async function collectText(client: LlmClient, messages: ChatMessage[]): Promise<string> {
  let text = "";
  for await (const ev of client.chat(messages, { maxTokens: 4096, temperature: 0.2 })) {
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
      return parseExtractionJson(raw, hint?.level ?? DEFAULT_LEVEL);
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
      return parseExtractionJson(raw, hint?.level ?? DEFAULT_LEVEL);
    },
  };
}
