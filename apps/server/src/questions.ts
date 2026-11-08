import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { QuestionSchema, type Question } from "@mathtutor/schema";
import type { GraphIndex } from "@mathtutor/knowledge";
import { normalizeText } from "@mathtutor/subject-math";

/**
 * 题目存储：file-first（data/knowledge/questions/*.json，git 版本化），
 * 服务端启动加载 + 校验 + 去重为内存索引。修改只经 confirm 通道写文件。
 */
export interface QuestionStore {
  all: Question[];
  byId: Map<string, Question>;
  byNode: Map<string, Question[]>;
  /**
   * 配图文件找不到的题。
   *
   * 题库里有"如图"题却把图丢了（58 道），孩子拿到手是一道读不懂的题，
   * 页面上也不会报错。这类题不进组卷——但要留一张名单，家长端与体检看得到，
   * 否则"题少了 58 道"永远没人知道为什么。
   */
  figureMissing: Set<string>;
  reload(): void;
}

/**
 * 这道题能不能发给孩子做。
 *
 * 拦一种情况：**答案是模型自己算的，而且还没有人核对过**。
 * 学生版讲义不印答案，抽取时模型会按提示自己解一个，可它解得不稳——
 * 同一道数三角形的题两次分别给出 48 和 84。拿这种数去判卷，
 * 孩子做对了会被判错，而他会开始怀疑自己而不是怀疑系统。
 *
 * 为什么不干脆拦下所有没抽检的题：手头几十份讲义，一次性抽检完不现实，
 * 那样等于题库建好了却没题可做。而真正危险的只是这一小撮——
 * 答案有出处（教师版印着的）的题，读错的概率远低于算错。
 *
 * 家长核对过（status=verified）就放行：那时这个数已经有人看过了。
 * 标记本身保留，它是这道题答案的来历，不该因为核对过就抹掉。
 */
/** 英语知识点的 id 前缀（与 lint 的前缀登记表一致：en / english） */
const ENGLISH_NODE_PREFIXES = ["en:", "english:"];

export function isEnglishNodeId(nodeId: string): boolean {
  return ENGLISH_NODE_PREFIXES.some((prefix) => nodeId.startsWith(prefix));
}

/**
 * 双语题的规矩：**有英文，就得有英语知识点**。
 *
 * 之所以要这条：一道题挂着英文题面却不关联任何英语节点，英文那部分既不判、
 * 也不进证据——它只是把中文题面翻译了一遍给家长看。这不算融合，算装饰。
 *
 * 反过来**不设**规矩：单学科题（数学基础、英语语法）不该被逼着挂别的学科。
 * 所以"全是英语节点"的题直接放行——这道题本身就是英语题，
 * 题面和要求都用英语是理所当然的，再要一条 `stemEn` 只是形式主义。
 */
export function bilingualIssues(q: Question, index: GraphIndex): string[] {
  const englishNodeIds = q.nodeIds.filter(isEnglishNodeId);
  if (englishNodeIds.length === q.nodeIds.length && englishNodeIds.length > 0) return [];
  if (englishNodeIds.length > 0) {
    // 混着挂（数学 + 英语）却不用英文：那个英语节点只是装饰
    const usesEnglish = Boolean(q.stemEn) || q.answerLang === "en";
    return usesEnglish
      ? []
      : [`挂了英语知识点 ${englishNodeIds.join(",")}，却没有英文题面也没要求英文作答：${q.id}`];
  }
  if (q.stemEn) {
    return [`有英文题面但没有英语知识点：要么补上（如 en:money-words），要么去掉英文题面 ${q.id}`];
  }
  if (q.answerLang === "en") {
    return [`要求用英语作答，却没有英语知识点：${q.id}`];
  }
  void index;
  return [];
}

export function practiceReady(q: Question): boolean {
  return !(q.answerUnverified && q.status !== "verified");
}

export function contentHashOf(stem: string, answer: string): string {
  return createHash("sha256").update(normalizeText(stem) + "\u0000" + normalizeText(answer)).digest("hex").slice(0, 16);
}

export interface QuestionLoadIssue {
  file: string;
  problem: string;
}

export function loadQuestionFiles(
  questionsDir: string,
  index: GraphIndex,
): { questions: Question[]; issues: QuestionLoadIssue[] } {
  const questions: Question[] = [];
  const issues: QuestionLoadIssue[] = [];
  const seenHash = new Map<string, string>();
  const seenId = new Set<string>();
  if (!existsSync(questionsDir)) return { questions, issues };
  for (const file of readdirSync(questionsDir).filter((f) => f.endsWith(".json")).sort()) {
    const full = path.join(questionsDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      issues.push({ file, problem: `JSON 解析失败: ${String(err)}` });
      continue;
    }
    if (!Array.isArray(raw)) {
      issues.push({ file, problem: "文件不是题目数组" });
      continue;
    }
    for (const item of raw) {
      const parsed = QuestionSchema.safeParse(item);
      if (!parsed.success) {
        issues.push({ file, problem: `题目 schema 校验失败: ${parsed.error.issues[0]?.message}` });
        continue;
      }
      const q = parsed.data;
      if (seenId.has(q.id)) {
        issues.push({ file, problem: `重复题目 id: ${q.id}` });
        continue;
      }
      const dupOf = seenHash.get(q.contentHash);
      if (dupOf) {
        issues.push({ file, problem: `内容重复（contentHash 同 ${dupOf}）: ${q.id}` });
        continue;
      }
      const badNodes = q.nodeIds.filter((n) => !index.nodeById.has(n));
      if (badNodes.length) {
        issues.push({ file, problem: `悬挂知识点 ${badNodes.join(",")}: ${q.id}` });
        continue;
      }
      // 双语题规矩：有英文就得有英语知识点（见 bilingualIssues）。
      // 这条必须对**每题**都跑——之前它被误放进了悬挂检查的 if 里，
      // 于是只有"知识点找不到"的题才会被查双语，正常的题一路放行。
      for (const problem of bilingualIssues(q, index)) issues.push({ file, problem });
      seenId.add(q.id);
      seenHash.set(q.contentHash, q.id);
      questions.push(q);
    }
  }
  return { questions, issues };
}

export function createQuestionStore(
  dataDir: string,
  index: GraphIndex,
  figuresDir?: string,
): QuestionStore {
  const dir = path.join(dataDir, "knowledge", "questions");
  const store: QuestionStore = {
    all: [],
    byId: new Map(),
    byNode: new Map(),
    figureMissing: new Set<string>(),
    reload() {
      const { questions, issues } = loadQuestionFiles(dir, index);
      for (const issue of issues) console.warn(`[questions] ${issue.file}: ${issue.problem}`);
      store.all = questions;
      // 题面配图丢了：题就不该发给孩题做（读不懂题比不做更伤）
      store.figureMissing = new Set(
        figuresDir
          ? questions.filter((q) => q.figureImage && !existsSync(path.join(figuresDir, q.figureImage))).map((q) => q.id)
          : [],
      );
      if (store.figureMissing.size) {
        console.warn(`[questions] ${store.figureMissing.size} 道题的原图找不到，已从组卷里排除（${figuresDir}）`);
      }
      store.byId = new Map(questions.map((q) => [q.id, q]));
      store.byNode = new Map();
      for (const q of questions)
        for (const n of q.nodeIds) {
          if (!store.byNode.has(n)) store.byNode.set(n, []);
          store.byNode.get(n)!.push(q);
        }
    },
  };
  store.reload();
  return store;
}

/**
 * 确认入库（ingest 管线的最后一步）：追加进指定批次文件，
 * 文件内 + 全库 contentHash 去重，写完调用方需 store.reload()。
 * 返回实际写入的题目（去重后）。
 */
export function appendQuestions(
  dataDir: string,
  batchName: string,
  incoming: Question[],
  store: QuestionStore,
): { written: Question[]; skippedDuplicates: number } {
  const dir = path.join(dataDir, "knowledge", "questions");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${batchName.replace(/[^\w一-龥-]/g, "_")}.json`);
  const existing: Question[] = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Question[])
    : [];
  const knownHashes = new Set([...store.all.map((q) => q.contentHash), ...existing.map((q) => q.contentHash)]);
  const knownIds = new Set([...store.byId.keys(), ...existing.map((q) => q.id)]);
  const written: Question[] = [];
  let skippedDuplicates = 0;
  for (const q of incoming) {
    if (knownHashes.has(q.contentHash) || knownIds.has(q.id)) {
      skippedDuplicates++;
      continue;
    }
    knownHashes.add(q.contentHash);
    knownIds.add(q.id);
    written.push(q);
  }
  if (written.length) writeFileSync(file, JSON.stringify([...existing, ...written], null, 2), "utf8");
  return { written, skippedDuplicates };
}
