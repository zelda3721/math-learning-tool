import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlannedLesson } from "./plan.js";

/**
 * 课程计划的存储：`data/knowledge/curricula/<名字>.json`，一本教材一份。
 *
 * 为什么不写进 graph.json：图谱是**知识结构**（谁是谁的先修），
 * 课程计划是**教学安排**（这本书先讲哪一课）。两者寿命不同——
 * 换一本教材，图谱不变而计划全变；把计划塞进图谱，等于让一份数据承担两种寿命，
 * 而任何一次教材更新都会变成一次图谱改动。
 *
 * 也不写进 links.json：那是跨学科连接表，见 PLAN 第三部分。
 */

export const CURRICULA_DIR = "curricula";

export interface CurriculumFile {
  /** 教材名（文件名由它派生），家长可读 */
  name: string;
  /** 排好的课，顺序即上课顺序 */
  lessons: PlannedLesson[];
  /** 生成时刻（ISO）：家长要能分辨"这是新版教材的计划吗" */
  createdAt: string;
}

/**
 * 名字 → 文件名。
 *
 * 只保留字母数字与中日文，其余折成连字符：教材名里常有空格、括号、冒号，
 * 直接当文件名会在某些系统上炸掉，而以 `.` 开头的名字会变成隐藏文件。
 */
export function curriculumFileName(name: string): string {
  const safe = name
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${safe || "curriculum"}.json`;
}

function curriculaDir(dataDir: string): string {
  return path.join(dataDir, "knowledge", CURRICULA_DIR);
}

export function saveCurriculum(dataDir: string, file: CurriculumFile): string {
  const dir = curriculaDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, curriculumFileName(file.name));
  writeFileSync(target, JSON.stringify(file, null, 2), "utf8");
  return target;
}

/** 读一份；不存在或坏掉返回 null——坏数据不该让家长页整页打不开 */
export function loadCurriculum(dataDir: string, name: string): CurriculumFile | null {
  const file = path.join(curriculaDir(dataDir), curriculumFileName(name));
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CurriculumFile>;
    if (!Array.isArray(parsed.lessons)) return null;
    return {
      name: typeof parsed.name === "string" ? parsed.name : name,
      lessons: parsed.lessons,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

export function listCurricula(dataDir: string): { name: string; lessonCount: number; createdAt: string }[] {
  const dir = curriculaDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: { name: string; lessonCount: number; createdAt: string }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const file = loadCurriculum(dataDir, entry.replace(/\.json$/, ""));
    if (!file) continue;
    out.push({ name: file.name, lessonCount: file.lessons.length, createdAt: file.createdAt });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
