import { Hono } from "hono";
import { availableLessons, composeLesson, pauseContextFor, pickLessonQuestion } from "./lesson.js";
import { buildLessonFromDraft, generateLessonDraft } from "./generate.js";
import type { AppState } from "../app.js";

/** 生成一节课最多等这么久：过了就先用离线课，模型写完也不要了（孩子已经在上课） */
const LESSON_GENERATE_TIMEOUT_MS = 45_000;

/**
 * 课堂路由（阶段 3）。
 *
 * 只做两件事：给一节**确定性组好的课**，以及列出"现在能开哪些课"。
 * 判卷不在这里——孩子答完题走已有的 /practice/submit（source=classroom），
 * 那条路已经有掌握度、证据等级、家长抽检这一整串；在这里再写一遍判卷，
 * 就是第二个会腐烂的实现。
 */
export function classroomRoutes(state: AppState): Hono {
    const app = new Hono();

    app.get("/lessons", (c) => {
        return c.json({ lessons: availableLessons(state.knowledge.index, state.questions) });
    });

    /*
     * 两种模式，一条接口：
     * - `compose`（默认）：确定性、离线可用，永远不会失败；
     * - `generate`：模型把课讲出来，**题目仍然来自题库**（模型看不到题、更看不到答案）。
     *   PLAN 要求 generate 失败退回 compose——所以这里永远有课可上，
     *   退回去的原因写在 `degraded` 里，否则"AI 课质量差"永远查不到是哪一环。
     */
    app.get("/lesson", async (c) => {
        const nodeId = c.req.query("nodeId");
        if (!nodeId) return c.json({ error: "需要 nodeId" }, 400);
        const mode = c.req.query("mode") === "generate" ? "generate" : "compose";

        const composed = composeLesson(nodeId, state.knowledge.index, state.questions);
        if (!composed) return c.json({ error: "这个知识点开不出一节课（图谱里没有，或档案里没有可讲的材料）" }, 404);

        const node = state.knowledge.index.getNode(nodeId);
        let degraded: { reason: string } | null = null;
        if (mode === "generate") {
            if (!node || !state.hintProvider) {
                degraded = { reason: state.hintProvider ? "知识点不存在" : "没有可用的模型端点" };
            } else {
                try {
                    const question = pickLessonQuestion(state.questions, nodeId);
                    /*
                     * 组课有时间上限。孩子在等一节课时，本地模型 90 秒还没吐完，
                     * 等下去不如给一节离线课：教室的门开着，比"再等等"有用。
                     * 超时同样算"退回 compose"，原因写清楚。
                     */
                    const draft = await Promise.race([
                        generateLessonDraft(node, { llm: state.hintProvider, question }),
                        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), LESSON_GENERATE_TIMEOUT_MS).unref?.()),
                    ]);
                    if (draft === "timeout") {
                        return c.json({
                            ...composed,
                            pauseContext: pauseContextFor(composed),
                            mode: "compose",
                            degraded: { reason: `模型 ${Math.round(LESSON_GENERATE_TIMEOUT_MS / 1000)} 秒没写完，先用离线组课` },
                            note: "已退回 compose 模式（模型超时）",
                        });
                    }
                    const built = draft === null ? null : buildLessonFromDraft(node, draft, question);
                    if (!built) {
                        degraded = { reason: "模型没有给出可用的课" };
                    } else if (!built.ok) {
                        degraded = { reason: built.reason };
                    } else {
                        return c.json({
                            ...built.lesson,
                            pauseContext: pauseContextFor(built.lesson),
                            mode: "generate",
                            degraded: null,
                            note: "generate 模式：讲解拍由模型写成，题目与判卷仍来自题库",
                        });
                    }
                } catch (err) {
                    // 模型超时/端点掉线都走这里：孩子不该因为模型挂了上不了课
                    degraded = { reason: `模型调用失败：${err instanceof Error ? err.message : String(err)}` };
                }
            }
        }

        return c.json({
            ...composed,
            // 给家长/调试看：孩子提问那一刻，上下文里**没有**这道题的答案
            pauseContext: pauseContextFor(composed),
            mode: "compose",
            degraded,
            note:
                degraded === null
                    ? "compose 模式：完全由知识点档案与题库拼出，不依赖引擎与模型"
                    : `已退回 compose 模式（${degraded.reason}）`,
        });
    });

    return app;
}
