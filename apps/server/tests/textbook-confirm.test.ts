import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeApp } from "./helpers.js";

/**
 * 确认与排课：写的是**课程计划文件**，不是图谱。
 * 两者寿命不同——换教材时图谱不变、计划全变，塞进同一份数据会互相拖累。
 */

async function post(app: ReturnType<typeof makeApp>["app"], url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /api/v1/textbook/confirm", () => {
  it("确认后按先修排序并落一份课程计划", async () => {
    const { app, state } = makeApp([]);
    const nodes = state.knowledge.graph.nodes;
    const withPrereq = nodes.find((n) => n.prerequisites.length > 0)!;
    const prereqId = withPrereq.prerequisites[0]!;

    const res = await post(app, "/api/v1/textbook/confirm", {
      name: "数学 五年级上",
      // 故意把前置写在后面：排课要把它提到前面
      lessons: [
        { chapterTitle: "第 2 章", nodeId: withPrereq.id },
        { chapterTitle: "第 1 章", nodeId: prereqId },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.lessons[0].nodeId).toBe(prereqId);
    expect(res.body.cycleDetected).toBe(false);

    // 真的落了文件，且图谱一个节点没变
    const file = path.join(state.config.dataDir, "knowledge", "curricula", "数学-五年级上.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.lessons).toHaveLength(2);
    expect(nodes.length).toBe(state.knowledge.graph.nodes.length);
  });

  it("节点不存在 → 422，且不写文件（前端传错不该让计划里出现不存在的课）", async () => {
    const { app, state } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/confirm", {
      name: "坏计划",
      lessons: [{ chapterTitle: "第 1 章", nodeId: "definitely-not-a-node" }],
    });
    expect(res.status).toBe(422);
    expect(existsSync(path.join(state.config.dataDir, "knowledge", "curricula", "坏计划.json"))).toBe(false);
  });

  it("列出已存的课程计划", async () => {
    const { app, state } = makeApp([]);
    const node = state.knowledge.graph.nodes[0]!;
    await post(app, "/api/v1/textbook/confirm", {
      name: "计划A",
      lessons: [{ chapterTitle: "第一章", nodeId: node.id }],
    });
    const res = await app.request("/api/v1/textbook/curricula");
    const body = await res.json();
    expect(body.curricula.map((c: { name: string }) => c.name)).toEqual(["计划A"]);
  });
});
