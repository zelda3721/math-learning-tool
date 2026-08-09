import { Hono } from "hono";
import { z } from "zod";
import { EducationLevelSchema } from "@mathtutor/schema";
import type { AppState } from "../app.js";

const CreateLearnerSchema = z.object({ name: z.string().min(1).max(32), level: EducationLevelSchema });

export function learnerRoutes(state: AppState): Hono {
  const app = new Hono();

  app.get("/", (c) => c.json({ learners: state.repo.listLearners() }));

  app.post("/", async (c) => {
    const parsed = CreateLearnerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 name 与 level" }, 400);
    const learner = state.repo.createLearner(parsed.data.name, parsed.data.level);
    return c.json({ learner }, 201);
  });

  return app;
}
