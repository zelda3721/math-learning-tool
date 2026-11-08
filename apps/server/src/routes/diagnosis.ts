import { Hono } from "hono";
import { effectiveLearnerId, type AppState } from "../app.js";
import { diagnoseMistake } from "../diagnosis.js";
import { childWorkedThrough } from "../explain/routes.js";

/** 诊断归因：错因 = 图谱坐标，附置信度与依据链（宪法第 4 条） */
export function diagnosisRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/:attemptId", async (c) => {
    const attempt = state.repo.getAttempt(c.req.param("attemptId"));
    const scoped = effectiveLearnerId(c, state, attempt?.learnerId);
    if (attempt && scoped && attempt.learnerId !== scoped) return c.json({ error: "无权访问" }, 403);
    /*
     * 孩子调归因：和界面路径同一道门。界面上只有「三级提示后仍错 → 先跳过」才会走到归因，
     * 可接口本身敞着，答错一次就能直接调；归因卡会把根因、误概念、依据链和一句错因
     * 摆出来——在孩子还没自己试完之前，这就是一条绕开提示阶梯的捷径。
     * 判据复用讲解那边的 childWorkedThrough：答对过，或三级提示用完且交过已判定的作答
     * （三级提示后的那次错答本身就满足后者）。家长不受限。
     */
    const user = c.get("user") as { role?: string } | undefined;
    if (attempt && user?.role === "child" && !childWorkedThrough(state.repo, attempt.learnerId, attempt.questionId)) {
      return c.json(
        {
          error: "先自己把这道题试完：答错了可以用提示，三级提示都用完再来看错在哪儿。",
          code: "diagnosis-locked",
        },
        403,
      );
    }
    const result = await diagnoseMistake({
      knowledge: state.knowledge,
      questions: state.questions,
      repo: state.repo,
      llm: state.hintProvider,
      attemptId: c.req.param("attemptId"),
    });
    if ("error" in result) return c.json({ error: result.error }, 404);
    return c.json(result);
  });

  app.get("/mistakes", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    const mistakes = state.repo.listMistakes(learnerId).map((m) => ({
      ...m,
      rootNodeName: state.knowledge.index.getNode(m.rootNodeId)?.name ?? m.rootNodeId,
      chainNames: m.chain.map((id) => state.knowledge.index.getNode(id)?.name ?? id),
      questionStem: state.questions.byId.get(m.questionId)?.stem,
    }));
    return c.json({ mistakes });
  });

  return app;
}
