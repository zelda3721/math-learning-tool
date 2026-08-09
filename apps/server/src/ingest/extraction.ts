import { LlmClient, loadLlmConfig, type ChatMessage } from "@mathtutor/llm-client";
import { z } from "zod";
import { EducationLevelSchema, type EducationLevel } from "@mathtutor/schema";

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
});

function normalizeDraft(item: z.infer<typeof LenientDraftSchema>, fallbackLevel: EducationLevel): ExtractedDraft {
  const difficulty = Number.isFinite(item.difficulty)
    ? Math.min(5, Math.max(1, Math.round(item.difficulty!)))
    : 2;
  return {
    stem: item.stem.trim(),
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

/** 离线文本兜底：分块成题干草稿，答案留空待人工填写 */
export function offlineTextDrafts(text: string, level: EducationLevel = DEFAULT_LEVEL): ExtractedDraft[] {
  return segmentQuestionsOffline(text).map((stem) => ({
    stem,
    answer: "",
    answerType: "numeric" as const,
    difficulty: 2,
    level,
  }));
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
- 材料里没有题目时输出 []。`;

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
export function createLlmExtractionProvider(env: NodeJS.ProcessEnv = process.env): ExtractionProvider {
  const config = loadLlmConfig(env);
  const textClient = LlmClient.fromEndpoint(config.fast);
  const visionClient = LlmClient.fromEndpoint(config.vision);
  return {
    async extractFromText(text, hint) {
      const raw = await collectText(textClient, [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(text, hint) },
      ]);
      return parseExtractionJson(raw, hint?.level ?? DEFAULT_LEVEL);
    },
    async extractFromImage(base64, mime, hint) {
      const raw = await collectText(visionClient, [
        { role: "system", content: SYSTEM_PROMPT },
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
