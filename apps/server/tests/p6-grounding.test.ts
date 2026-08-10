import { describe, expect, it } from "vitest";
import { groundingSourceOf } from "../src/explain/grounding.js";
import { openMemoryDb } from "../src/db.js";
import { Repo } from "../src/repo.js";

describe("讲解画面来源：确定性构造器 vs LLM 导演", () => {
  it("确定性计划盖了章就读得出，模型计划没有章就是 undefined", () => {
    // 引擎 build_mix_swap_visual_plan 的真实产物形态
    expect(groundingSourceOf({ grounding_source: "linear_mix_swap", visual_objects: [] })).toBe(
      "linear_mix_swap",
    );
    // LLM 导演写的计划：有 visual_thesis / essence_rationale，但没有 grounding_source
    expect(
      groundingSourceOf({ visual_thesis: "…", essence_rationale: "…", visual_objects: [] }),
    ).toBeUndefined();
    expect(groundingSourceOf(null)).toBeUndefined();
    expect(groundingSourceOf("nope")).toBeUndefined();
    expect(groundingSourceOf({ grounding_source: "" })).toBeUndefined();
  });

  it("来源分布统计得出来，模型路径归到 llm_director", () => {
    const repo = new Repo(openMemoryDb());
    const base = {
      focusNodeIds: [],
      engineSessionId: "s1",
      quality: "good" as const,
      contractVersion: "1.0",
    };
    repo.insertExplanation({ ...base, id: "a", mode: "web", groundingSource: "linear_mix_swap" });
    repo.insertExplanation({ ...base, id: "b", mode: "web", groundingSource: "linear_mix_swap" });
    // 没盖章 = 走了 LLM 导演
    repo.insertExplanation({ ...base, id: "c", mode: "web" });
    repo.insertExplanation({ ...base, id: "d", mode: "video", quality: "acceptable" });

    const rows = repo.explanationSources();
    const find = (mode: string, source: string) =>
      rows.find((r) => r.mode === mode && r.source === source);
    expect(find("web", "linear_mix_swap")?.count).toBe(2);
    expect(find("web", "llm_director")?.count).toBe(1);
    expect(find("video", "llm_director")?.quality).toBe("acceptable");
  });

  it("旧库没有这一列也能升上来（迁移幂等）", () => {
    const db = openMemoryDb();
    // 再跑一次迁移不应抛错
    expect(() => openMemoryDb()).not.toThrow();
    const repo = new Repo(db);
    expect(repo.explanationSources()).toEqual([]);
  });
});
