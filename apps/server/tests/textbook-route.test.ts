import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";

/**
 * 教材对齐：从**编译产物**出图谱候选。
 *
 * 之前这条路是按章抽点、按章对齐（/propose），和编译产物各走各的——
 * /confirm 认的是章节标题，编译出来的概念根本接不到排课上。
 * 现在只有一条链：compile → align → confirm。
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

async function waitJob(app: App, jobId: string) {
  for (let i = 0; i < 100; i++) {
    const job = (await (await app.request(`/api/v1/textbook/compile/${jobId}`)).json()) as Record<string, any>;
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("编译任务没有在预期时间内结束");
}

/** 造一个"书里就是这么说"的章节 + provider，保证概念能有可定位的出处 */
function bookFor(nodeName: string) {
  const sentence = `${nodeName}是指把整体平均分成若干份，表示这样一份或几份的数。`;
  const pages = [{ page: 1, text: `第一章 ${nodeName}\n${sentence}` }];
  const provider = {
    async extract() {
      return [
        { title: nodeName, definition: sentence, keyPoints: ["平均分"], prerequisites: [], evidence: sentence },
        // 编造的引文（够长、能过清洗，但正文里找不到）→ 不该进候选
        {
          title: `${nodeName}（模型臆测）`,
          definition: "随便写的",
          keyPoints: [],
          prerequisites: [],
          evidence: "这句话在书里并不存在，是模型自己写的一段像原文的东西。",
        },
      ];
    },
  };
  return { pages, provider };
}

describe("POST /api/v1/textbook/align", () => {
  it("从编译产物按概念出候选；出处定位不到的概念不进候选", async () => {
    // 编译用的 app 自带 provider；align 与它共用同一个 state 与数据目录
    const compiled = makeApp([]);
    const state = compiled.state;
    const nodeName = state.knowledge.graph.nodes[0]!.name;
    const { pages, provider } = bookFor(nodeName);
    compiled.state.textbookProvider = provider;
    const res = await post(compiled.app, "/api/v1/textbook/compile", { title: "数学 五年级上", pages });
    const job = await waitJob(compiled.app, String(res.body.jobId));
    expect(job.status).toBe("done");

    // 用同一个 state/数据目录再请求 align
    const aligned = await post(compiled.app, "/api/v1/textbook/align", { name: "数学 五年级上" });
    expect(aligned.status).toBe(200);
    expect(aligned.body.items).toHaveLength(1);
    expect(aligned.body.items[0].conceptTitle).toBe(nodeName);
    expect(aligned.body.items[0].status).toBe("pending");
    // 候选里应当有同名节点
    expect(aligned.body.items[0].candidates.map((c: { nodeId: string }) => c.nodeId)).toContain(
      state.knowledge.graph.nodes[0]!.id,
    );
    expect(aligned.body.skippedUnverified).toBe(1);
    expect(aligned.body.note).toContain("图谱不会被直接修改");
  });

  it("图谱一个节点都不增加（只出候选，不写入）", async () => {
    const compiled = makeApp([]);
    const state = compiled.state;
    const nodeName = state.knowledge.graph.nodes[0]!.name;
    const { pages, provider } = bookFor(nodeName);
    compiled.state.textbookProvider = provider;

    const before = state.knowledge.graph.nodes.length;
    const res = await post(compiled.app, "/api/v1/textbook/compile", { title: "数学", pages });
    await waitJob(compiled.app, String(res.body.jobId));
    await post(compiled.app, "/api/v1/textbook/align", { name: "数学" });

    expect(state.knowledge.graph.nodes.length).toBe(before);
  });

  it("没有编译产物时 404，说清要先 compile", async () => {
    const { app } = makeApp([]);
    const res = await post(app, "/api/v1/textbook/align", { name: "没有这本书" });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/compile");
  });

  it("旧的 /propose 已经删掉（同一件事只留一种实现）", async () => {
    const { app } = makeApp([]);
    const res = await app.request("/api/v1/textbook/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pages: [{ page: 1, text: "x" }] }),
    });
    expect(res.status).toBe(404);
  });
});
