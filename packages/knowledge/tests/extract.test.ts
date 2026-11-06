import { describe, expect, it } from "vitest";
import { extractKnowledgePoints, extractOffline, type DraftExtractionProvider } from "../src/extract.js";

/**
 * 知识点抽取。两条要求：每条草稿必须带得住的原文；
 * 模型不可用时整条链不能停——那恰恰是家长最想先看看的时候。
 */

const chapter = {
  title: "分数的意义",
  fromPage: 1,
  toPage: 1,
  text: "把一个整体平均分成若干份，表示这样一份或几份的数叫分数。\n分数的分母表示平均分成的份数，分子表示取了多少份。\n分数也可以看成除法：分子除以分母。",
};

describe("离线兜底", () => {
  it("按段落聚合，每条都带原文证据", () => {
    const drafts = extractOffline(chapter);
    expect(drafts.length).toBe(3);
    for (const d of drafts) {
      expect(d.evidence.length).toBeGreaterThanOrEqual(12);
      expect(d.title.length).toBeGreaterThan(0);
    }
  });

  it("太短的段落不产出草稿（撑不起一次对齐）", () => {
    const drafts = extractOffline({ ...chapter, text: "短。\n\n这一段足够长，可以作为一个知识点的证据来使用。" });
    expect(drafts).toHaveLength(1);
  });
});

describe("有模型时", () => {
  const provider = (drafts: unknown[]): DraftExtractionProvider => ({
    extract: async () => drafts as never,
  });

  it("用模型给的草稿，degraded 为 false", async () => {
    const r = await extractKnowledgePoints(chapter, provider([
      { title: "分数的意义", summary: "把整体平均分", evidence: "把一个整体平均分成若干份，表示这样一份或几份的数叫分数。" },
    ]));
    expect(r.degraded).toBe(false);
    expect(r.drafts[0]!.title).toBe("分数的意义");
  });

  it("模型抛错 → 退回离线兜底，不让整条链停住", async () => {
    const r = await extractKnowledgePoints(chapter, {
      extract: async () => {
        throw new Error("端点不可达");
      },
    });
    expect(r.degraded).toBe(true);
    expect(r.drafts.length).toBeGreaterThan(0);
  });

  it("模型给空数组 → 也走兜底（抽不出东西和模型坏了对家长是同一件事）", async () => {
    const r = await extractKnowledgePoints(chapter, provider([]));
    expect(r.degraded).toBe(true);
    expect(r.drafts.length).toBeGreaterThan(0);
  });

  it("证据不足的草稿被丢掉：不让对齐凭空多出没依据的候选", async () => {
    const r = await extractKnowledgePoints(chapter, provider([
      { title: "有证据的", summary: "s", evidence: "这一段是足够长的原文证据，可以直接用于对齐图谱节点。" },
      { title: "没证据的", summary: "s", evidence: "短" },
    ]));
    expect(r.drafts.map((d) => d.title)).toEqual(["有证据的"]);
  });
});
