import type { EducationLevel } from "@mathtutor/schema";
import { normalizeText } from "../grading.js";
import {
  offlineTextDrafts,
  segmentQuestionsOffline,
  type ExtractedDraft,
  type ExtractionProvider,
} from "./extraction.js";

/**
 * P1b 批量抽取：分块（控制单次 LLM 上下文）+ 教师-学生版配对。
 * 学生版定题面（干净无答案），教师版对齐答案与解析（设计 §06 上传管线）。
 */

export interface BatchFile {
  name: string;
  /** 已抽出的纯文本（PDF 文本层/粘贴文本；图片在路由层先经 vision 转 drafts 不走此路径） */
  text: string;
  role: "teacher" | "student" | "auto";
}

export interface PairingReport {
  matched: number;
  teacherOnly: number;
  studentOnly: number;
}

/**
 * 按题号边界把长文本切块，每块不超过 maxChars（喂 LLM 的上下文纪律）。
 * segmentQuestionsOffline 会剥掉题号，拼块时必须补回编号——
 * 否则下游（离线兜底的再分段）无法把多题块重新拆开。
 */
export function chunkByQuestions(text: string, maxChars = 2600): string[] {
  const segments = segmentQuestionsOffline(text);
  const source = segments.length > 1 ? segments.map((seg, i) => `${i + 1}. ${seg}`) : [text];
  const chunks: string[] = [];
  let current = "";
  for (const seg of source) {
    if (current && current.length + seg.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + seg;
    // 单段超长（无题号的整页文字）：硬切
    while (current.length > maxChars) {
      chunks.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/** 中文 bigram 集合相似度（0-1），用于师生版题干配对 */
export function stemSimilarity(a: string, b: string): number {
  const bigrams = (t: string): Set<string> => {
    const clean = normalizeText(t);
    const out = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
    return out;
  };
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let overlap = 0;
  for (const g of sa) if (sb.has(g)) overlap++;
  return overlap / Math.min(sa.size, sb.size);
}

/**
 * 教师-学生版配对：题干相似度 ≥ threshold 视为同题。
 * 产出以学生版题面为准、教师版答案/解析补全；未配对的教师版题也保留（它有答案）。
 */
export function pairDrafts(
  studentDrafts: ExtractedDraft[],
  teacherDrafts: ExtractedDraft[],
  threshold = 0.6,
): { drafts: ExtractedDraft[]; report: PairingReport } {
  const usedTeacher = new Set<number>();
  const drafts: ExtractedDraft[] = [];
  let matched = 0;
  for (const student of studentDrafts) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < teacherDrafts.length; i++) {
      if (usedTeacher.has(i)) continue;
      const score = stemSimilarity(student.stem, teacherDrafts[i]!.stem);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= threshold) {
      const teacher = teacherDrafts[bestIdx]!;
      usedTeacher.add(bestIdx);
      matched++;
      drafts.push({
        ...student,
        answer: student.answer || teacher.answer,
        analysis: student.analysis ?? teacher.analysis,
        // 教师版通常判定更准的字段：答案类型与难度沿用教师版（有值时）
        answerType: teacher.answer ? teacher.answerType : student.answerType,
      });
    } else {
      drafts.push(student);
    }
  }
  const teacherOnly: ExtractedDraft[] = teacherDrafts.filter((_, i) => !usedTeacher.has(i));
  drafts.push(...teacherOnly);
  return {
    drafts,
    report: {
      matched,
      teacherOnly: teacherOnly.length,
      studentOnly: studentDrafts.length - matched,
    },
  };
}

export interface BatchProgress {
  stage: "extract" | "pair" | "done";
  current: number;
  total: number;
  file?: string;
}

/**
 * 批量抽取主流程：逐文件分块抽取（LLM 失败回退离线分块），
 * 有师生两版时配对合并。onProgress 用于任务进度上报。
 */
export async function processBatch(
  files: BatchFile[],
  provider: ExtractionProvider | null,
  level: EducationLevel | undefined,
  onProgress: (p: BatchProgress) => void,
): Promise<{ drafts: ExtractedDraft[]; warnings: string[]; pairing: PairingReport | null }> {
  const warnings: string[] = [];
  const byRole = new Map<string, ExtractedDraft[]>();

  const allChunks = files.flatMap((f) => chunkByQuestions(f.text).map((chunk) => ({ file: f, chunk })));
  let done = 0;
  for (const { file, chunk } of allChunks) {
    onProgress({ stage: "extract", current: done, total: allChunks.length, file: file.name });
    let drafts: ExtractedDraft[];
    if (provider) {
      try {
        drafts = await provider.extractFromText(chunk, { level });
      } catch (err) {
        warnings.push(`${file.name}: LLM 抽取失败（${String(err)}），该块回退离线分块`);
        drafts = offlineTextDrafts(chunk, level);
      }
    } else {
      drafts = offlineTextDrafts(chunk, level);
    }
    const role = file.role === "auto" ? guessRole(file.name) : file.role;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role)!.push(...drafts);
    done++;
  }
  if (!provider) warnings.push("未配置 LLM 抽取端点，使用离线分块兜底：答案与解析需人工填写");

  const student = byRole.get("student") ?? [];
  const teacher = byRole.get("teacher") ?? [];
  let drafts: ExtractedDraft[];
  let pairing: PairingReport | null = null;
  if (student.length && teacher.length) {
    onProgress({ stage: "pair", current: 0, total: student.length });
    const paired = pairDrafts(student, teacher);
    drafts = paired.drafts;
    pairing = paired.report;
  } else {
    drafts = [...student, ...teacher];
  }
  onProgress({ stage: "done", current: allChunks.length, total: allChunks.length });
  return { drafts, warnings, pairing };
}

/** 从文件名猜版本：含「教师/答案/详解」→ teacher，含「学生」→ student，默认 student */
export function guessRole(fileName: string): "teacher" | "student" {
  if (/教师|答案|详解|解析版/.test(fileName)) return "teacher";
  return "student";
}
