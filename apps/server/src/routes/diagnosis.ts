import { Hono } from "hono";
import type { AppState } from "../app.js";
import { diagnoseMistake } from "../diagnosis.js";

/** 诊断归因：错因 = 图谱坐标，附置信度与依据链（宪法第 4 条） */
export function diagnosisRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/:attemptId", async (c) => {
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
    const learnerId = c.req.query("learnerId");
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
