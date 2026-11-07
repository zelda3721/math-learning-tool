import { Hono } from "hono";
import { availableLessons, composeLesson, pauseContextFor } from "./lesson.js";
import type { AppState } from "../app.js";

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

    app.get("/lesson", (c) => {
        const nodeId = c.req.query("nodeId");
        if (!nodeId) return c.json({ error: "需要 nodeId" }, 400);

        const lesson = composeLesson(nodeId, state.knowledge.index, state.questions);
        if (!lesson) return c.json({ error: "这个知识点开不出一节课（图谱里没有，或档案里没有可讲的材料）" }, 404);

        return c.json({
            ...lesson,
            // 给家长/调试看：孩子提问那一刻，上下文里**没有**这道题的答案
            pauseContext: pauseContextFor(lesson),
            note: "compose 模式：完全由知识点档案与题库拼出，不依赖引擎与模型",
        });
    });

    return app;
}
