import { LlmClient, loadLlmConfig, type ChatMessage } from "@mathtutor/llm-client";

/**
 * 拍照作答判卷（P3）：vision 识别手写最终答案 → 交给确定性判卷；
 * 识别不自信/为空 → needsReview 进家长判卷抽检队列（低置信度不硬判）。
 */
export interface PhotoGrader {
  extractAnswer(base64: string, mime: string, questionStem: string): Promise<{ answer: string; confident: boolean }>;
}

const SYSTEM = `你是手写数学作业识别器。图片是学生对一道题的手写作答。
只输出 JSON（不要其他文字）：{"answer":"学生写的最终答案（数值题只写数和单位）","confident":true|false}
规则：最终答案通常在末尾/等号右边/答字后面；字迹不清或找不到明确最终答案时 answer 给你最可能的读法、confident 给 false。`;

export function createPhotoGrader(env: NodeJS.ProcessEnv = process.env): PhotoGrader {
  const config = loadLlmConfig(env);
  const client = LlmClient.fromEndpoint(config.vision);
  return {
    async extractAnswer(base64, mime, questionStem) {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: `题目：${questionStem}\n请识别学生的最终答案。` },
            { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
          ] as unknown as string,
        },
      ];
      let raw = "";
      for await (const ev of client.chat(messages, { maxTokens: 200, temperature: 0 })) {
        if (ev.type === "text") raw += ev.text;
      }
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          const parsed = JSON.parse(raw.slice(start, end + 1)) as { answer?: unknown; confident?: unknown };
          if (typeof parsed.answer === "string") {
            return { answer: parsed.answer, confident: parsed.confident === true };
          }
        } catch {
          // fall through
        }
      }
      return { answer: raw.trim().slice(0, 50), confident: false };
    },
  };
}
