import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadKnowledge } from "../src/load.js";
import { confirmedLinks, decide, proposeAlignment, proposeChapter } from "../src/align.js";

/**
 * 教材对齐是**提案**，不是写入。
 *
 * 这条约束在代码上的落点只有一个函数：confirmedLinks()。没有家长裁决，
 * 它永远返回空数组——这就是"绝不直接写入"。
 */

const knowledge = loadKnowledge({
  graphPath: fileURLToPath(new URL("../../../data/knowledge/graph.json", import.meta.url)),
  problemsPath: fileURLToPath(new URL("../../../data/knowledge/problems.json", import.meta.url)),
});

const chapter = { title: "分数的意义", text: "把一个整体平均分成若干份，表示这样一份或几份的数叫分数。" };

describe("产生候选", () => {
  it("给得出带理由的候选，且不改动图谱", () => {
    const before = knowledge.graph.nodes.length;
    const item = proposeChapter(knowledge.index, chapter.title, chapter.text);
    expect(item.status).toBe("pending");
    expect(item.chosen).toBeNull();
    // 每个候选都要有理由：家长看不懂"为什么是它"就没法判断
    for (const c of item.candidates) expect(c.reasons.length).toBeGreaterThan(0);
    expect(knowledge.graph.nodes.length).toBe(before);
  });

  it("没有候选也是诚实的结果，不硬凑一个低分节点", () => {
    const item = proposeChapter(knowledge.index, "zzzz", "qqqq 无关内容 zzzz");
    // 无论有没有候选，都不影响它仍然是 pending
    expect(item.status).toBe("pending");
  });
});

describe("家长裁决", () => {
  const proposal = proposeAlignment(knowledge.index, [chapter]);
  const firstCandidate = proposal.items[0]!.candidates[0];

  it("没裁决前，没有任何东西可以写进图谱", () => {
    expect(confirmedLinks(proposal)).toEqual([]);
    expect(proposal.pendingCount).toBe(1);
  });

  it("确认之后才出现，且只出现那一个", () => {
    if (!firstCandidate) return; // 真实图谱下总能匹配到，保险起见
    const decided = decide(proposal, chapter.title, {
      status: "confirmed",
      nodeId: firstCandidate.nodeId,
    });
    expect(confirmedLinks(decided)).toEqual([
      { chapterTitle: chapter.title, nodeId: firstCandidate.nodeId },
    ]);
    expect(decided.pendingCount).toBe(0);
    // 原提案不被改动：家长要能复核"当初给了什么候选"
    expect(proposal.items[0]!.status).toBe("pending");
  });

  it("拒绝 → 仍然什么都不写", () => {
    const decided = decide(proposal, chapter.title, { status: "rejected" });
    expect(confirmedLinks(decided)).toEqual([]);
    expect(decided.pendingCount).toBe(0);
  });

  it("确认一个候选里没有的节点 → 不生效（前端传错不该让图谱里多出没评估过的节点）", () => {
    const decided = decide(proposal, chapter.title, {
      status: "confirmed",
      nodeId: "definitely-not-a-candidate",
    });
    expect(decided.items[0]!.status).toBe("pending");
    expect(confirmedLinks(decided)).toEqual([]);
  });
});
