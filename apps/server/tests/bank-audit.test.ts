/**
 * 语义核查：逐题问模型「这道题挂的知识点对不对」。
 *
 * 结构核查（/audit）不用读题就能判；但常见的错法是**结构上完全合法、
 * 语义上不对**——一道数图形的题挂着「表内乘除法」，两边都在图谱里、
 * 学段也对，谁也看不出来。这里守的是这条路上不该出的错。
 */
import { describe, expect, it } from "vitest";
import { auditPrompt, runSemanticAudit, type AuditChat } from "../src/bankAudit.js";
import { knowledge, makeQuestion, NODE_A } from "./helpers.js";

describe("auditPrompt", () => {
  const q = makeQuestion({
    id: "q1",
    stem: "数一数下图中有多少个三角形？",
    answer: "8",
    level: "elementary_upper",
    nodeIds: [NODE_A],
  });

  it("把题干、答案、现有知识点都摆给模型", () => {
    const p = auditPrompt(knowledge, q);
    expect(p).toContain("数一数下图中有多少个三角形");
    expect(p).toContain("答案：8");
    expect(p).toContain(NODE_A);
  });

  it("候选清单按学段筛——不然小学题会被判成高中「解三角形」", () => {
    const p = auditPrompt(knowledge, q);
    const senior = knowledge.graph.nodes.filter((n) => n.stage === "senior");
    expect(senior.length).toBeGreaterThan(0);
    // 小学题的清单里不该出现高中节点
    for (const n of senior.slice(0, 10)) expect(p).not.toContain(`${n.id}(`);
  });

  it("讲清判断标准是「要用到什么才做得出来」，不是题面出现了什么词", () => {
    expect(auditPrompt(knowledge, q)).toContain("不是题面里出现了什么词");
  });
});

/** 假模型：按题干挑一份预设回答。真 client 会去连网络，测试里注入这个 */
const fakeChat = (replies: Record<string, string>): AuditChat => ({
  async *chat(messages) {
    const text = String(messages[1]?.content ?? "");
    const key = Object.keys(replies).find((k) => text.includes(k));
    yield { type: "text", text: key ? replies[key]! : '{"ok":true,"better":[]}' };
  },
});

describe("runSemanticAudit", () => {
  const q = (id: string, stem: string, nodeIds = [NODE_A]) =>
    makeQuestion({ id, stem, nodeIds, level: "elementary_upper" });

  it("模型说合适的不进结果——只有存疑的才需要人看", async () => {
    const r = await runSemanticAudit(knowledge, [q("q1", "长方形周长")], {
      chat: fakeChat({}),
    });
    expect(r.checked).toBe(1);
    expect(r.disputed).toEqual([]);
  });

  it("说不合适、且给了图谱里真有的知识点，才算存疑", async () => {
    const r = await runSemanticAudit(knowledge, [q("q1", "数一数有多少个三角形")], {
      chat: fakeChat({
        "数一数": '{"ok":false,"better":["problem-solving-primary"],"why":"考的是有序枚举"}',
      }),
    });
    expect(r.disputed).toHaveLength(1);
    expect(r.disputed[0]!.suggested).toEqual(["problem-solving-primary"]);
    expect(r.disputed[0]!.why).toContain("有序枚举");
  });

  /** 图谱里没有的说法一律吸附或丢掉——绝不凭空造节点（与抽取同一条纪律） */
  it("近似说法能吸附到真实节点", async () => {
    // 「勾股定理应用」不是节点名，但吸附得上 pythagorean——这正是吸附该干的事
    const r = await runSemanticAudit(knowledge, [q("q1", "某道题")], {
      chat: fakeChat({ 某道题: '{"ok":false,"better":["勾股定理应用"],"why":"x"}' }),
    });
    expect(r.disputed[0]!.suggested).toEqual(["pythagorean"]);
  });

  it("完全吸不上的说法记为线索，不当成建议", async () => {
    const r = await runSemanticAudit(knowledge, [q("q1", "某道题")], {
      chat: fakeChat({ 某道题: '{"ok":false,"better":["量子纠缠入门"],"why":"x"}' }),
    });
    // 不报建议：这一步报的是"模型建议改成什么"，吸不上就没有建议
    expect(r.disputed).toEqual([]);
    // 但记下来——这是"我们缺哪个节点"的线索
    expect(r.dropped).toContain("量子纠缠入门");
  });

  it("建议和现在一样就不算存疑——模型只是换了个说法", async () => {
    const r = await runSemanticAudit(knowledge, [q("q1", "某道题")], {
      chat: fakeChat({ 某道题: `{"ok":false,"better":["${NODE_A}"],"why":"x"}` }),
    });
    expect(r.disputed).toEqual([]);
  });

  it("一道题问不出来不拖垮整批", async () => {
    const boom: AuditChat = {
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error("端点挂了");
      },
    };
    const r = await runSemanticAudit(knowledge, [q("q1", "甲"), q("q2", "乙")], { chat: boom });
    expect(r.checked).toBe(2);
    expect(r.disputed).toEqual([]);
  });

  it("模型答非所问时跳过，不当成存疑", async () => {
    const r = await runSemanticAudit(knowledge, [q("q1", "某道题")], {
      chat: fakeChat({ 某道题: "我觉得这道题挺好的。" }),
    });
    expect(r.disputed).toEqual([]);
  });

  it("进度按题上报，跑得久也看得见", async () => {
    const seen: number[] = [];
    await runSemanticAudit(knowledge, [q("q1", "甲"), q("q2", "乙")], {
      chat: fakeChat({}),
      onProgress: (p) => seen.push(p.done),
    });
    expect(seen).toEqual([0, 1, 2]);
  });
});

/**
 * 存疑要分档。
 *
 * 实测 170 道跑出 96 条存疑，混在一起等于没给：真正值得改的只有 63 条，
 * 另外 24 条建议跨了学段（18 条是把小学题往「一元一次方程」上带——
 * 用方程解小学奥数题在数学上不算错，但对小学生的知识点标注是错的，
 * 照着改会让星图点亮初中的星），9 条只是想少挂一个。
 */
describe("存疑分档", () => {
  const q = (id: string, stem: string, nodeIds: string[]) =>
    makeQuestion({ id, stem, nodeIds, level: "elementary_upper" });

  it("跨学段的建议单独归档，不混进值得改的那批", async () => {
    const r = await runSemanticAudit(
      knowledge,
      [q("q1", "小学奥数题", ["problem-solving-primary"])],
      { chat: fakeChat({ 小学奥数题: '{"ok":false,"better":["linear-equation"],"why":"设未知数"}' }) },
    );
    expect(r.disputed[0]!.kind).toBe("cross-stage");
    expect(r.byKind.actionable).toBe(0);
  });

  it("建议是现有的子集 = 只想少挂一个，也单独归档", async () => {
    const r = await runSemanticAudit(
      knowledge,
      [q("q1", "某题", ["problem-solving-primary", "add-sub-100"])],
      { chat: fakeChat({ 某题: '{"ok":false,"better":["add-sub-100"],"why":"用不到策略"}' }) },
    );
    expect(r.disputed[0]!.kind).toBe("narrower");
  });

  it("同学段换了知识点才算值得改", async () => {
    const r = await runSemanticAudit(knowledge, [q("q1", "数三角形", ["simple-counting"])], {
      chat: fakeChat({ 数三角形: '{"ok":false,"better":["shape-counting"],"why":"考的是有序枚举"}' }),
    });
    expect(r.disputed[0]!.kind).toBe("actionable");
    expect(r.byKind.actionable).toBe(1);
  });

  it("值得改的排在最前——人从上往下看就是从最该改的开始", async () => {
    const r = await runSemanticAudit(
      knowledge,
      [
        q("cross", "甲题", ["problem-solving-primary"]),
        q("act", "数三角形", ["simple-counting"]),
      ],
      {
        chat: fakeChat({
          甲题: '{"ok":false,"better":["linear-equation"],"why":"x"}',
          数三角形: '{"ok":false,"better":["shape-counting"],"why":"y"}',
        }),
      },
    );
    expect(r.disputed.map((d) => d.kind)).toEqual(["actionable", "cross-stage"]);
  });
})
