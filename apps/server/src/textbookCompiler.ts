import { loadLlmConfig, type ChatMessage } from "@mathtutor/llm-client";
import { createServerLlmClient } from "./llm.js";
import type { ConceptDraft, ConceptExtractionProvider } from "@mathtutor/knowledge";

/**
 * 概念抽取的模型端：教材一章正文 → 一批概念草稿。
 *
 * 走 main 这一档端点（本地 oMLX 常驻模型），temperature 压到 0.2：
 * 教材抽取要的是**书里怎么写的**，不是模型的发挥；同一本书两次编译
 * 概念名稍微飘一点，产物就没法比。
 *
 * 输出必须是 JSON。解析刻意宽容（模型爱在前后加解释、```json 围栏），
 * 但字段一律交回 compile.ts 清洗：这里只负责"拿到形状对的东西"，
 * 证据长度、上限、去重那些判定都在纯逻辑层，能测。
 */

const SYSTEM = `你是教材知识编译器。给你教材的一章正文，请把这一章涉及的知识点编译成概念清单。

只输出 JSON 数组（不要任何解释文字、不要 markdown 围栏）。每个元素：
{"title":"概念名（尽量用书里的叫法，短）","definition":"一句话定义","keyPoints":["要点1","要点2"],"prerequisites":["先修概念名"],"evidence":"原文中能支撑这个概念的一段话（照抄，不要改写）"}

规则：
1. title 用书里出现过的叫法；同一个概念不要拆成两条。
2. definition 复述书里的说法，不要引入书里没有的内容。
3. evidence 必须是从正文**原样摘录**的句子，至少一句完整的话；摘不出来就不要输出这一条。
4. prerequisites 只填书里明确讲过要先会的概念；没有就给空数组。
5. 一章最多 10 条，宁可少而准。`;

export interface TextbookCompilerOptions {
  /** 覆盖默认提示词（测试与调参用） */
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** 审计落盘的数据根；省略则不落审计 */
  dataDir?: string;
}

export function createTextbookCompiler(
  env: NodeJS.ProcessEnv = process.env,
  options: TextbookCompilerOptions = {},
): ConceptExtractionProvider {
  const config = loadLlmConfig(env);
  const client = createServerLlmClient(config, "main", { dataDir: options.dataDir });
  const system = options.systemPrompt ?? SYSTEM;

  return {
    async extract({ chapterTitle, text }): Promise<ConceptDraft[]> {
      const messages: ChatMessage[] = [
        { role: "system", content: system },
        {
          role: "user",
          content: `章节：${chapterTitle}\n\n正文：\n${text.slice(0, 12000)}`,
        },
      ];

      let raw = "";
      for await (const ev of client.chat(messages, {
        maxTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.2,
      })) {
        if (ev.type === "text") raw += ev.text;
      }
      return parseConceptDrafts(raw);
    },
  };
}

/**
 * 从模型输出里挖出概念数组。
 *
 * 不抛异常：解析不出来就返回空数组，让 compile.ts 退回离线兜底并标 degraded——
 * 一条坏输出不该让整本书编译失败。
 */
export function parseConceptDrafts(raw: string): ConceptDraft[] {
  const text = raw.trim();
  if (!text) return [];

  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) candidates.push(text.slice(arrayStart, arrayEnd + 1));
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) candidates.push(`[${text.slice(objStart, objEnd + 1)}]`);

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { concepts?: unknown }).concepts)
          ? ((parsed as { concepts: unknown[] }).concepts)
          : null;
      if (!list) continue;
      return list.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        return [
          {
            title: typeof record.title === "string" ? record.title : "",
            definition: typeof record.definition === "string" ? record.definition : "",
            keyPoints: Array.isArray(record.keyPoints)
              ? record.keyPoints.filter((p): p is string => typeof p === "string")
              : [],
            prerequisites: Array.isArray(record.prerequisites)
              ? record.prerequisites.filter((p): p is string => typeof p === "string")
              : [],
            evidence: typeof record.evidence === "string" ? record.evidence : "",
          },
        ];
      });
    } catch {
      // 换个候选继续挖
    }
  }
  return [];
}
