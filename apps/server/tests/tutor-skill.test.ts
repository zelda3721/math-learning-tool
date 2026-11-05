import { describe, expect, it } from "vitest";
import { parseSkill } from "@mathtutor/core";
import { buildSystemPrompt, exploreSkill, toolsFor } from "../src/explore.js";
import { knowledge } from "./helpers.js";

/**
 * 导师 = 一个代理 + 技能文件。
 *
 * 这两条是阶段 1 的收口断言：
 * 1. 探索用的提示词来自 `skills/math/explore/SKILL.md`，不是代码里的隐藏副本；
 * 2. 技能声明用哪些工具，代理就只拿到哪些——用提示词做权限控制从来没成功过。
 */

const SKILL = parseSkill(
  `---
name: demo
subject: math
description: 测试用
tools: graph_query, not_a_real_tool
---
你是探索伙伴。
{{context}}
规则：追问。
`,
  "mem://demo",
);

describe("探索技能来自 SKILL.md", () => {
  it("仓库里的技能能被代理找到，id 与工具都在册", () => {
    const skill = exploreSkill();
    expect(skill?.id).toBe("math/explore");
    expect(skill?.tools).toEqual(["graph_query", "find_similar"]);
  });

  it("系统提示 = 技能正文 + 本次会话的年级/焦点", () => {
    const node = knowledge.graph.nodes[0]!;
    const prompt = buildSystemPrompt(knowledge, SKILL, "elementary_upper", node.id);
    expect(prompt).toContain("你是探索伙伴。");
    expect(prompt).toContain("小学高年级");
    expect(prompt).toContain(node.name);
    // 占位符必须被替换掉，不能原样发给模型
    expect(prompt).not.toContain("{{context}}");
  });

  it("没写占位符的技能：上下文拼在正文之前，而不是丢失", () => {
    const plain = parseSkill(
      "---\nname: plain\nsubject: math\ndescription: d\n---\n正文在这里。",
      "mem://plain",
    );
    const prompt = buildSystemPrompt(knowledge, plain, "middle");
    expect(prompt).toContain("初中");
    expect(prompt).toContain("正文在这里。");
  });

  it("技能只声明即工具的子集就只拿到子集；未实现的工具名被忽略", () => {
    const tools = toolsFor(SKILL);
    expect(tools.map((t) => t.name)).toEqual(["graph_query"]);
  });
});
