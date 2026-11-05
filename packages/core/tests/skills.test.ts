import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SkillError, loadSkills, parseSkill, resolveSkill } from "../src/skills.js";

/**
 * 导师技能（SKILL.md）：一个代理 + 多个学科技能。
 *
 * 这些用例盯的是"写坏了的技能要吵，而不是安静消失"——
 * 一个被静默忽略的技能，表现是"这个功能莫名其妙不见了"，比启动报错难查得多。
 */

const SKILL = `---
name: explore
subject: math
title: 探索引导
description: 陪孩子在星图里漫游
tools: graph_query, find_similar
---
你是探索伙伴。
{{context}}
规则一：追问。
`;

describe("SKILL.md 解析", () => {
  it("解析出 id / 工具列表 / 正文", () => {
    const s = parseSkill(SKILL, "mem://skill");
    expect(s.id).toBe("math/explore");
    expect(s.title).toBe("探索引导");
    expect(s.tools).toEqual(["graph_query", "find_similar"]);
    expect(s.body).toContain("规则一：追问");
  });

  it("没有 tools 也能解析（纯对话技能不需要工具）", () => {
    const s = parseSkill(SKILL.replace("tools: graph_query, find_similar\n", ""), "mem://skill");
    expect(s.tools).toEqual([]);
  });

  it("缺 frontmatter / 缺必填字段 / 正文为空 → 报错并指出文件", () => {
    expect(() => parseSkill("没有 frontmatter", "mem://a")).toThrow(SkillError);
    expect(() => parseSkill("---\nname: x\nsubject: math\n---\n正文", "mem://b")).toThrow(/缺 description/);
    expect(() =>
      parseSkill("---\nname: x\nsubject: math\ndescription: d\n---\n\n", "mem://c"),
    ).toThrow(/正文/);
  });

  it("name/subject 不合规（大写、空格、中文）→ 报错（它们要进寻址路径）", () => {
    expect(() =>
      parseSkill("---\nname: Explore Now\nsubject: math\ndescription: d\n---\n正文", "mem://d"),
    ).toThrow(SkillError);
    expect(() =>
      parseSkill("---\nname: explore\nsubject: 数学\ndescription: d\n---\n正文", "mem://e"),
    ).toThrow(SkillError);
  });
});

describe("目录加载与寻址", () => {
  function makeRoot(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "skills-"));
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    return root;
  }

  it("按 skills/<subject>/<name>/SKILL.md 收罗", () => {
    const root = makeRoot({
      "math/explore/SKILL.md": SKILL,
      "math/withdraw/SKILL.md": SKILL.replace("name: explore", "name: withdraw"),
      "en/vocab/SKILL.md": SKILL.replace("name: explore", "name: vocab").replace("subject: math", "subject: en"),
      "math/README.md": "不是技能，忽略",
    });
    const skills = loadSkills(root);
    expect(skills.map((s) => s.id).sort()).toEqual(["en/vocab", "math/explore", "math/withdraw"]);
  });

  it("目录与 frontmatter 的学科不一致 → 报错（否则寻址会走错门）", () => {
    const root = makeRoot({ "math/explore/SKILL.md": SKILL.replace("subject: math", "subject: en") });
    expect(() => loadSkills(root)).toThrow(/目录是 math/);
  });

  it("目录不存在 → 空数组，不抛错（没有技能的部署仍然能跑）", () => {
    expect(loadSkills(path.join(tmpdir(), "definitely-not-a-skills-dir"))).toEqual([]);
  });

  it("寻址：显式名字优先；只给学科时仅在该学科唯一技能才返回", () => {
    const root = makeRoot({
      "math/explore/SKILL.md": SKILL,
      "math/withdraw/SKILL.md": SKILL.replace("name: explore", "name: withdraw"),
      "en/vocab/SKILL.md": SKILL.replace("name: explore", "name: vocab").replace("subject: math", "subject: en"),
    });
    const skills = loadSkills(root);
    expect(resolveSkill(skills, "math", "explore")?.id).toBe("math/explore");
    expect(resolveSkill(skills, "en")?.id).toBe("en/vocab");
    // 数学有两个技能：只给学科就不猜
    expect(resolveSkill(skills, "math")).toBeUndefined();
  });
});

describe("仓库里真实的技能文件", () => {
  const skillsRoot = fileURLToPath(new URL("../../../skills", import.meta.url));

  it("全部能解析，且数学探索技能在册", () => {
    const skills = loadSkills(skillsRoot);
    const explore = skills.find((s) => s.id === "math/explore");
    expect(explore).toBeDefined();
    // 宪法条款留在提示词里（不喂答案、要追问）
    expect(explore!.body).toContain("追问");
    expect(explore!.body).toContain("不直接给出");
    expect(explore!.tools).toEqual(["graph_query", "find_similar"]);
  });
});
