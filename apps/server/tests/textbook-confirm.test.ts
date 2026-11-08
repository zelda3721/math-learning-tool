import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makeApp } from "./helpers.js";

/**
 * 确认与排课：写的是**课程计划文件**，不是图谱。
 * 两者寿命不同——换教材时图谱不变、计划全变，塞进同一份数据会互相拖累。
 *
 * 确认清单认的是**编译产物的概念 id**，不是章节标题：课程计划要能回指
 * "这本书里的哪一条概念"，否则改天就说不清这一课对应什么。
 */

type App = ReturnType<typeof makeApp>["app"];

async function post(app: App, url: string, body: unknown) {
  const res = await app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** 正文要够长：证据不足 12 字的草稿会被清洗掉（那是对的），测试得用真句子 */
const SENTENCE_A = "把整体平均分成若干份，表示这样一份的数叫分数。";
const SENTENCE_B = "分子表示取了多少份，分母表示平均分成的份数。";
const PAGES = [{ page: 1, text: `第一章 分数\n${SENTENCE_A}\n${SENTENCE_B}` }];

const twoConcepts = {
  async extract() {
    return [
      { title: "分数的组成", definition: "分子与分母。", keyPoints: [], prerequisites: [], evidence: SENTENCE_B },
      { title: "分数的意义", definition: "表示这样一份或几份的数。", keyPoints: [], prerequisites: [], evidence: SENTENCE_A },
    ];
  },
};


describe("POST /api/v1/textbook/confirm", () => {
  it("确认后按先修排序并落一份课程计划", async () => {
    const { app, state } = makeApp([], {
      textbookProvider: twoConcepts,
    });

    const compiled = await post(app, "/api/v1/textbook/compile", { title: "数学 五年级上", pages: PAGES });
    const job = await waitJob(app, String(compiled.body.jobId));
    const idOf = (t: string) => job.result.concepts.find((c: { title: string }) => c.title === t).id;

    const nodes = state.knowledge.graph.nodes;
    const withPrereq = nodes.find((n) => n.prerequisites.length > 0)!;
    const prereqId = withPrereq.prerequisites[0]!;

    const res = await post(app, "/api/v1/textbook/confirm", {
      name: "数学 五年级上",
      // 故意把前置的概念排在后面：排课要把它提到前面
      lessons: [
        { conceptId: idOf("分数的组成"), nodeId: withPrereq.id },
        { conceptId: idOf("分数的意义"), nodeId: prereqId },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.lessons[0].nodeId).toBe(prereqId);
    expect(res.body.lessons[0].conceptId).toBe(idOf("分数的意义"));
    expect(res.body.cycleDetected).toBe(false);

    // 真的落了文件，且图谱一个节点没变
    const file = path.join(state.config.dataDir, "knowledge", "curricula", "数学-五年级上.json");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.lessons).toHaveLength(2);
    expect(saved.lessons[0].conceptId).toBe(idOf("分数的意义"));
    expect(nodes.length).toBe(state.knowledge.graph.nodes.length);
  });

  it("节点不存在 → 422，且不写文件（前端传错不该让计划里出现不存在的课）", async () => {
    const { app, state } = makeApp([], {
      textbookProvider: twoConcepts,
    });
    const compiled = await post(app, "/api/v1/textbook/compile", { title: "坏计划", pages: PAGES });
    const job = await waitJob(app, String(compiled.body.jobId));

    const res = await post(app, "/api/v1/textbook/confirm", {
      name: "坏计划",
      lessons: [{ conceptId: job.result.concepts[0].id, nodeId: "definitely-not-a-node" }],
    });
    expect(res.status).toBe(422);
    expect(existsSync(path.join(state.config.dataDir, "knowledge", "curricula", "坏计划.json"))).toBe(false);
  });

  it("概念 id 不在编译产物里 → 422（计划必须回指到书里的某一条）", async () => {
    const { app } = makeApp([], {
      textbookProvider: twoConcepts,
    });
    const compiled = await post(app, "/api/v1/textbook/compile", { title: "计划B", pages: PAGES });
    await waitJob(app, String(compiled.body.jobId));

    const res = await post(app, "/api/v1/textbook/confirm", {
      name: "计划B",
      lessons: [{ conceptId: "deadbeef", nodeId: "counting-20" }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("deadbeef");
  });

  it("没有编译产物时 404（确认清单不能凭空来）", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/confirm", {
      name: "不存在的书",
      lessons: [{ conceptId: "x", nodeId: "counting-20" }],
    });
    expect(res.status).toBe(404);
  });

  it("列出已存的课程计划", async () => {
    const { app } = makeApp([], {
      textbookProvider: twoConcepts,
    });
    const compiled = await post(app, "/api/v1/textbook/compile", { title: "计划A", pages: PAGES });
    const job = await waitJob(app, String(compiled.body.jobId));

    await post(app, "/api/v1/textbook/confirm", {
      name: "计划A",
      lessons: [{ conceptId: job.result.concepts[0].id, nodeId: "counting-20" }],
    });
    const body = (await (await app.request("/api/v1/textbook/curricula")).json()) as { curricula: { name: string }[] };
    expect(body.curricula.map((c) => c.name)).toEqual(["计划A"]);
  });
});

async function waitJob(app: App, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const job = (await (await app.request(`/api/v1/textbook/compile/${jobId}`)).json()) as Record<string, any>;
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("编译任务没有在预期时间内结束");
}
