import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadKnowledge } from "../src/load.js";
import { planCurriculum } from "../src/plan.js";

/**
 * 排课：只在不违反先修的前提下调整顺序；没有关系的一律保持原书顺序。
 * 教材作者比我们更懂这本书的叙事顺序，信息不足时不要自作主张。
 */

const knowledge = loadKnowledge({
  graphPath: fileURLToPath(new URL("../../../data/knowledge/graph.json", import.meta.url)),
  problemsPath: fileURLToPath(new URL("../../../data/knowledge/problems.json", import.meta.url)),
});

// 从真实图谱里挑一对有先修关系的节点，避免手写数据集脱离实际
const withPrereq = knowledge.graph.nodes.find((n) => n.prerequisites.length > 0)!;
const prereqId = withPrereq.prerequisites[0]!;
const prereqName = knowledge.index.getNode(prereqId)?.name ?? prereqId;

describe("按先修排课", () => {
  it("前置被写在后面时，会排到前面，并说明为什么", () => {
    const plan = planCurriculum(knowledge.index, [
      { chapterTitle: "第 2 章（书上先讲）", nodeId: withPrereq.id },
      { chapterTitle: "第 1 章（书上后讲）", nodeId: prereqId },
    ]);
    const ids = plan.lessons.map((l) => l.nodeId);
    expect(ids.indexOf(prereqId)).toBeLessThan(ids.indexOf(withPrereq.id));
    // 被推后的那条要写明理由，否则家长会以为顺序错了
    const moved = plan.lessons.find((l) => l.nodeId === withPrereq.id)!;
    expect(moved.movedBecauseOf.join()).toContain(prereqName);
    expect(plan.cycleDetected).toBe(false);
  });

  it("没有先修关系的，保持原书顺序（信息不足时不自作主张）", () => {
    const a = knowledge.graph.nodes[0]!;
    const b = knowledge.graph.nodes[knowledge.graph.nodes.length - 1]!;
    const plan = planCurriculum(knowledge.index, [
      { chapterTitle: "先", nodeId: a.id },
      { chapterTitle: "后", nodeId: b.id },
    ]);
    expect(plan.lessons.map((l) => l.chapterTitle)).toEqual(["先", "后"]);
  });

  it("课程编号从 1 起，家长要能按号数上课", () => {
    const plan = planCurriculum(knowledge.index, [{ chapterTitle: "唯一一章", nodeId: withPrereq.id }]);
    expect(plan.lessons[0]).toMatchObject({ order: 1, chapterTitle: "唯一一章" });
  });

  it("没确认任何东西 → 空计划，不凭空排出一节课", () => {
    expect(planCurriculum(knowledge.index, []).lessons).toEqual([]);
  });

  it("未确认的节点不参与排序（不替家长做决定）", () => {
    // 只确认了后置节点：它的前置没被确认，因此不会被"顺带加进来"
    const plan = planCurriculum(knowledge.index, [{ chapterTitle: "只有后置", nodeId: withPrereq.id }]);
    expect(plan.lessons).toHaveLength(1);
    expect(plan.lessons[0]!.nodeId).toBe(withPrereq.id);
  });
});
