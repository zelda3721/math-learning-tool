import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * 导师技能（SKILL.md）。
 *
 * 一个导师代理 + 多个学科技能：代理只有一套工具与一条对话循环，
 * 「这个学科该怎么带」写在技能文件里。理由很实在——
 * 每加一门学科就复制一份代理代码，那些真正需要随学科变化的其实只有提示词与工具子集。
 *
 * 文件格式（`skills/<subject>/<name>/SKILL.md`）：
 *
 *     ---
 *     name: explore
 *     subject: math
 *     title: 探索引导
 *     description: 陪孩子在星图里自由漫游
 *     tools: graph_query, find_similar
 *     ---
 *     正文即提示词……
 *
 * 刻意不用 YAML 依赖：这里只需要「键: 值」与逗号分隔的列表，
 * 引一个 YAML 解析器换来的表达力，在这个用途上一行都用不到。
 */

export interface Skill {
  /** `<subject>/<name>`，全局唯一，也是调用时的寻址方式 */
  id: string;
  name: string;
  subject: string;
  title: string;
  description: string;
  /** 这个技能允许调用的工具名（实现由调用方提供） */
  tools: string[];
  /** 提示词正文 */
  body: string;
  /** 来源文件路径，报错时能直接指到哪一份 */
  source: string;
}

export class SkillError extends Error {}

const REQUIRED = ["name", "subject", "description"] as const;

export function parseSkill(text: string, source: string): Skill {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new SkillError(`${source}: 缺 frontmatter（文件必须以 --- 开头）`);
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new SkillError(`${source}: frontmatter 没有闭合的 ---`);

  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 5).trim();
  if (!body) throw new SkillError(`${source}: 正文（提示词）为空`);

  const fields = new Map<string, string>();
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i <= 0) throw new SkillError(`${source}: frontmatter 行无法解析：${t}`);
    fields.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }

  for (const key of REQUIRED) {
    if (!fields.get(key)) throw new SkillError(`${source}: frontmatter 缺 ${key}`);
  }

  const name = fields.get("name")!;
  const subject = fields.get("subject")!;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new SkillError(`${source}: name 只能是小写字母/数字/连字符（现在是 ${name}）`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(subject)) {
    throw new SkillError(`${source}: subject 只能是小写字母/数字/连字符（现在是 ${subject}）`);
  }

  const tools = (fields.get("tools") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    id: `${subject}/${name}`,
    name,
    subject,
    title: fields.get("title") ?? name,
    description: fields.get("description")!,
    tools,
    body,
    source,
  };
}

/**
 * 加载 `skills/` 下的全部技能。
 *
 * 解析失败直接抛错而不是跳过：一个写坏的技能文件被静默忽略，
 * 表现是"这个技能莫名其妙不见了"，那比启动时报错难查得多。
 */
export function loadSkills(skillsRoot: string): Skill[] {
  if (!existsSync(skillsRoot)) return [];
  const skills: Skill[] = [];
  const seen = new Set<string>();

  for (const subject of readdirSync(skillsRoot)) {
    const subjectDir = path.join(skillsRoot, subject);
    if (!statSync(subjectDir).isDirectory()) continue;
    for (const name of readdirSync(subjectDir)) {
      const file = path.join(subjectDir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      const skill = parseSkill(readFileSync(file, "utf8"), file);
      if (skill.subject !== subject) {
        throw new SkillError(
          `${file}: 目录是 ${subject}，frontmatter 写的 subject 是 ${skill.subject}`,
        );
      }
      if (seen.has(skill.id)) throw new SkillError(`技能 id 重复: ${skill.id}`);
      seen.add(skill.id);
      skills.push(skill);
    }
  }
  return skills;
}

/** 按键寻址：先按 `${subject}/${name}`，再退回"该学科下唯一的那个技能" */
export function resolveSkill(
  skills: Skill[],
  subject: string,
  name?: string,
): Skill | undefined {
  if (name) return skills.find((s) => s.id === `${subject}/${name}`);
  const ofSubject = skills.filter((s) => s.subject === subject);
  return ofSubject.length === 1 ? ofSubject[0] : undefined;
}
