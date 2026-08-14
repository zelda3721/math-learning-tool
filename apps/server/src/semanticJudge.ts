/**
 * 语义判卷：规则判不准时，问模型「孩子的答案和参考答案是不是同一个意思」。
 *
 * 为什么需要它：判卷规则已经堆了七层——数值、分段、名字对应、限定词、
 * 等式验算、条目序号、「或」分支——每个真实案例加一条，这条路走不到头。
 * 「田田27kg」和「27」是不是一回事，本质是语义问题，不是语法问题；
 * 语义问题就该交给语言模型，规则永远追不完人类写答案的花样。
 *
 * 但要有纪律。三层架构，各守各的界：
 *
 *   规则层   确凿的对与错它来拍板——快、免费、可复现，也是回归测试的锚。
 *            规则说得准的，模型无权推翻。
 *   语义层   只接规则判不准（pending）的案子，而且**只许判对，不许判错**：
 *            模型说 correct 才生效；说 wrong、说 unsure、超时、答非所问，
 *            一律维持 pending 交家长。这条不对称是本项目一路的纪律——
 *            误判"对"孩子只是侥幸一次，误判"错"孩子会开始怀疑自己，
 *            两种错的代价差一个量级。
 *   家长层   最终仲裁不变。模型放行的每一次都记进 learner_events，可审。
 */
import { LlmClient, loadLlmConfig, type ChatMessage } from "@mathtutor/llm-client";

/** 只用到 chat 一件事；抽成接口是为了测试能注入假模型（与 bankAudit 同一模式） */
export interface JudgeChat {
  chat(
    messages: ChatMessage[],
    opts?: { maxTokens?: number; temperature?: number },
  ): AsyncIterable<{ type: string; text?: string }>;
}

export interface JudgeInput {
  stem: string;
  reference: string;
  student: string;
}

export interface JudgeVerdict {
  verdict: "correct" | "wrong" | "unsure";
  why: string;
}

const SYSTEM = "你在核对一道数学题的作答意思对不对。只输出一个 JSON 对象，不要解释。";

export function judgePrompt(input: JudgeInput): string {
  return [
    `题目：${input.stem}`,
    `参考答案：${input.reference}`,
    `孩子的作答：${input.student}`,
    "",
    "孩子的作答和参考答案**是不是同一个意思**？输出：",
    '{"verdict":"correct" 或 "wrong" 或 "unsure","why":"一句话"}',
    "",
    "判断规则：",
    "- 只比对**意思**：单位写不写、顺序怎么排、带不带名字标注、换一种说法，都不影响对错。",
    '  「田田27kg，牛牛26kg」对着参考「27;26」，名字对上了就是 correct；',
    "- 名字或对象**配错了值**是 wrong，不是形式问题；",
    "- 需要自己重新解题才能验证的、孩子答案缺一部分的、看不懂的，一律 unsure；",
    "- 拿不准就 unsure——unsure 会交给家长，判错一个对的孩子代价大得多。",
  ].join("\n");
}

function parseVerdict(raw: string): JudgeVerdict | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (o.verdict !== "correct" && o.verdict !== "wrong" && o.verdict !== "unsure") return null;
    return { verdict: o.verdict, why: typeof o.why === "string" ? o.why.trim() : "" };
  } catch {
    return null;
  }
}

/** 判卷等在提交请求里，孩子在屏幕前等——模型再慢也不能拖过这个数 */
const JUDGE_TIMEOUT_MS = 20_000;

export type AnswerJudge = (input: JudgeInput) => Promise<JudgeVerdict | null>;

/**
 * 造一个判官。任何失败（超时、断连、答非所问）都返回 null——
 * 调用方把 null 当 pending 处理，语义层坏了顶多退回"交家长"，绝不拦路。
 */
export function createAnswerJudge(chat: JudgeChat): AnswerJudge {
  return async (input) => {
    const run = (async () => {
      let raw = "";
      for await (const ev of chat.chat(
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: judgePrompt(input) },
        ],
        { maxTokens: 256, temperature: 0.1 },
      )) {
        if (ev.type === "text") raw += ev.text;
      }
      return parseVerdict(raw);
    })();
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), JUDGE_TIMEOUT_MS),
    );
    try {
      return await Promise.race([run, timeout]);
    } catch {
      return null;
    }
  };
}

/** 从环境配置造判官（fast 端点）；配不出来返回 null，一切照旧 */
export function buildAnswerJudge(env: NodeJS.ProcessEnv = process.env): AnswerJudge | null {
  try {
    const config = loadLlmConfig(env);
    return createAnswerJudge(LlmClient.fromEndpoint(config.fast));
  } catch {
    return null;
  }
}
